-- Staff role: lets employees process the cloud scan queue without full admin.
-- Also locks the scan-correction RPCs down to signed-in users — they were
-- executable by anon, which becomes a real exposure once publishable-key
-- desktop builds are distributed.

-- 1. Allow 'staff' in user_roles
ALTER TABLE public.user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'user'::text, 'staff'::text]));

-- 2. is_staff(): true for staff AND admins (admins are a superset of staff)
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role IN ('staff', 'admin')
  );
$$;
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated, service_role;

-- 3. Additive drawer policies (permissive OR with the existing
--    is_admin()/created_by policies, which stay untouched)
CREATE POLICY drawer_select_staff ON public.drawer
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY drawer_update_staff ON public.drawer
  FOR UPDATE TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- 4. Admin-guarded role management (avoids documenting raw inserts)
CREATE OR REPLACE FUNCTION public.grant_staff_role(p_email text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'grant_staff_role: admin only';
  END IF;
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no auth user with that email');
  END IF;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, 'staff')
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'user_id', v_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_staff_role(p_email text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'revoke_staff_role: admin only';
  END IF;
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no auth user with that email');
  END IF;
  DELETE FROM public.user_roles WHERE user_id = v_user_id AND role = 'staff';
  RETURN jsonb_build_object('ok', true, 'user_id', v_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_staff_role(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_staff_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_staff_role(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_staff_role(text) TO authenticated, service_role;

-- 5. Scan-correction RPCs: signed-in users only (were anon-executable)
REVOKE EXECUTE ON FUNCTION public.record_scan_correction(uuid, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revert_scan_correction(uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.record_dxf_upload(uuid, text, integer, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_drawer_changelog(uuid) FROM PUBLIC, anon;