-- Admin-role management from the Employees tab + employees-only user list.
--
-- WHAT
--   1. grant_admin_role(p_email) / revoke_admin_role(p_email) — the admin
--      counterparts of grant/revoke_staff_role. Sam asked for admin
--      management in the UI (this deliberately supersedes the earlier
--      "admin is SQL-only" stance). revoke refuses to remove the LAST
--      admin (raises, so the whole transaction aborts — no lockout), and
--      takes an advisory lock so two concurrent revokes can't race past
--      the count check.
--   2. admin_list_users() v2 — returns ONLY accounts that hold at least one
--      role (employees). Customers no longer appear on the Employees tab
--      (they have their own tab); this closes the "uncheck the filter and
--      see every customer email" leak. Adds invited_at so the UI can show
--      an "invite pending" badge (invited_at set + never signed in).
--      Return type changes, so drop + recreate (precedent: 20260802120000).
--
-- WHY
--   Employees tab round 2 (Sam, 2026-08-27): set/reset staff passwords,
--   grant/revoke admin, and stop listing customer contacts among employees.
--
-- ROLLBACK
--   drop function public.grant_admin_role(text);
--   drop function public.revoke_admin_role(text);
--   drop function public.admin_list_users();
--   then re-run admin_list_users from 20260715191910_admin_list_users_rpc.sql.
--
-- VERIFY (dev)
--   As an admin session: select public.grant_admin_role('<email>');  -- ok
--   select public.revoke_admin_role('<email>');                      -- ok
--   Attempting to revoke the only remaining admin raises
--   'cannot remove the last admin'. admin_list_users() returns only
--   role-holding accounts and includes invited_at.

-- 1) grant_admin_role ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_admin_role(p_email text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'grant_admin_role: admin only';
  END IF;
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no auth user with that email');
  END IF;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'user_id', v_user_id);
END;
$$;
REVOKE ALL ON FUNCTION public.grant_admin_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_admin_role(text) TO authenticated, service_role;

-- 2) revoke_admin_role --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_admin_role(p_email text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'revoke_admin_role: admin only';
  END IF;
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no auth user with that email');
  END IF;
  -- Serialize admin revokes so two concurrent calls can't both pass the
  -- last-admin check and demote everyone.
  PERFORM pg_advisory_xact_lock(hashtext('user_roles.admin'));
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_user_id AND role = 'admin')
     AND (SELECT count(*) FROM public.user_roles WHERE role = 'admin') <= 1 THEN
    -- Raise (not a soft error) so the whole transaction aborts — there is no
    -- state in which the system is left without an admin.
    RAISE EXCEPTION 'cannot remove the last admin';
  END IF;
  DELETE FROM public.user_roles WHERE user_id = v_user_id AND role = 'admin';
  RETURN jsonb_build_object('ok', true, 'user_id', v_user_id);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_admin_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_admin_role(text) TO authenticated, service_role;

-- 3) admin_list_users v2 — employees only, with invited_at --------------------
DROP FUNCTION IF EXISTS public.admin_list_users();

CREATE FUNCTION public.admin_list_users()
RETURNS TABLE(user_id uuid, email text, roles text[], created_at timestamptz, last_sign_in_at timestamptz, invited_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_list_users: admin only';
  END IF;
  RETURN QUERY
    SELECT u.id, u.email::text,
           array_agg(r.role ORDER BY r.role),
           u.created_at, u.last_sign_in_at, u.invited_at
    FROM auth.users u
    JOIN public.user_roles r ON r.user_id = u.id
    GROUP BY u.id, u.email, u.created_at, u.last_sign_in_at, u.invited_at
    ORDER BY u.created_at;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated, service_role;
