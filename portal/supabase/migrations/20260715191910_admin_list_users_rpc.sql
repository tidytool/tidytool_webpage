-- Admin-only user/role listing for the web portal's employee-management UI.
-- Completes the role-management API: admin_list_users + grant_staff_role +
-- revoke_staff_role, all callable with the publishable key from a signed-in
-- admin session.
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE(user_id uuid, email text, roles text[], created_at timestamptz, last_sign_in_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_list_users: admin only';
  END IF;
  RETURN QUERY
    SELECT u.id, u.email::text,
           COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}'::text[]),
           u.created_at, u.last_sign_in_at
    FROM auth.users u
    LEFT JOIN public.user_roles r ON r.user_id = u.id
    GROUP BY u.id, u.email, u.created_at, u.last_sign_in_at
    ORDER BY u.created_at;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated, service_role;