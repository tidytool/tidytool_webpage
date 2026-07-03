SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
COMMENT ON SCHEMA "public" IS 'standard public schema';
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";
CREATE TYPE "public"."drawer_status" AS ENUM (
    'backlogged_by_admin',
    'created_by_user',
    'received_by_tidydesk',
    'processed_by_tidydesk',
    'approved_by_qualityctrl',
    'received_by_fabricator'
);
ALTER TYPE "public"."drawer_status" OWNER TO "postgres";
COMMENT ON TYPE "public"."drawer_status" IS 'signifies the drawers progress through the customer delivery pipeline';
CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;
ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";
SET default_tablespace = '';
SET default_table_access_method = "heap";
CREATE TABLE IF NOT EXISTS "public"."customer" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "phone" "text",
    "email" "text"
);
ALTER TABLE "public"."customer" OWNER TO "postgres";
COMMENT ON TABLE "public"."customer" IS 'The one who buys';
CREATE TABLE IF NOT EXISTS "public"."drawer" (
    "id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "order_id" "uuid",
    "photo_url" "text",
    "dimensions" json,
    "dxf_url" "text",
    "nickname" "text",
    "status" "public"."drawer_status",
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "point_cloud_url" "text",
    "qr_url" "text" GENERATED ALWAYS AS (('https://thetidytool.com/q/?d='::"text" || ("id")::"text")) STORED
);
ALTER TABLE "public"."drawer" OWNER TO "postgres";
COMMENT ON TABLE "public"."drawer" IS 'contains all information to process and store organizers';
COMMENT ON COLUMN "public"."drawer"."qr_url" IS 'Permanent public QR target (https://thetidytool.com/q/?d={id}). Auto-generated; do not write directly.';
CREATE TABLE IF NOT EXISTS "public"."drawer_backup_2026_05_02" (
    "id" "uuid",
    "created_at" timestamp with time zone,
    "order_id" "uuid",
    "photo_url" "text",
    "dimensions" json,
    "dxf_url" "text",
    "nickname" "text",
    "status" "public"."drawer_status",
    "created_by" "uuid",
    "point_cloud_url" "text"
);
ALTER TABLE "public"."drawer_backup_2026_05_02" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."employee" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone" "text" NOT NULL,
    "name_first" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "catchphrase" "text" NOT NULL,
    "name_last" "text"
);
ALTER TABLE "public"."employee" OWNER TO "postgres";
COMMENT ON TABLE "public"."employee" IS 'Order processing/tidyCad operator';
CREATE TABLE IF NOT EXISTS "public"."order" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_name" "text",
    "project_name" "text",
    "customer_email" "text",
    "customer_phone" "text",
    "location" "text",
    "notes" "text",
    "drawer_count" bigint,
    "total_price" bigint,
    "drawer_ids" "text",
    "created_by" "uuid" DEFAULT "auth"."uid"()
);
ALTER TABLE "public"."order" OWNER TO "postgres";
COMMENT ON TABLE "public"."order" IS 'unique orders from clients containing the order details and links to all the included drawers';
CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    CONSTRAINT "user_roles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'user'::"text"])))
);
ALTER TABLE "public"."user_roles" OWNER TO "postgres";
ALTER TABLE ONLY "public"."employee"
    ADD CONSTRAINT "Employee_phone_key" UNIQUE ("phone");
ALTER TABLE ONLY "public"."customer"
    ADD CONSTRAINT "customer_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."drawer"
    ADD CONSTRAINT "drawer_id_key" UNIQUE ("id");
ALTER TABLE ONLY "public"."drawer"
    ADD CONSTRAINT "drawer_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."employee"
    ADD CONSTRAINT "employee_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."order"
    ADD CONSTRAINT "order_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role");
ALTER TABLE ONLY "public"."drawer"
    ADD CONSTRAINT "drawer_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id");
ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
CREATE POLICY "Enable read access for all users" ON "public"."drawer" FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON "public"."employee" FOR SELECT USING (true);
ALTER TABLE "public"."customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."drawer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."drawer_backup_2026_05_02" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "drawer_insert_authenticated" ON "public"."drawer" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND (("order_id" IS NULL) OR (EXISTS ( SELECT 1
   FROM "public"."order" "o"
  WHERE (("o"."id" = "drawer"."order_id") AND ("o"."created_by" = "auth"."uid"())))))));
CREATE POLICY "drawer_update_authenticated" ON "public"."drawer" FOR UPDATE TO "authenticated" USING (("created_by" = "auth"."uid"())) WITH CHECK ((("created_by" = "auth"."uid"()) AND (("order_id" IS NULL) OR (EXISTS ( SELECT 1
   FROM "public"."order" "o"
  WHERE (("o"."id" = "drawer"."order_id") AND ("o"."created_by" = "auth"."uid"())))))));
CREATE POLICY "drawers insert" ON "public"."drawer" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "created_by"));
CREATE POLICY "drawers select" ON "public"."drawer" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("created_by" = "auth"."uid"())));
CREATE POLICY "drawers update" ON "public"."drawer" FOR UPDATE TO "authenticated" USING (("public"."is_admin"() OR ("created_by" = "auth"."uid"()))) WITH CHECK (("public"."is_admin"() OR ("created_by" = "auth"."uid"())));
ALTER TABLE "public"."employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."order" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_insert_authenticated" ON "public"."order" FOR INSERT TO "authenticated" WITH CHECK (("created_by" = "auth"."uid"()));
CREATE POLICY "order_select_authenticated" ON "public"."order" FOR SELECT TO "authenticated" USING (("created_by" = "auth"."uid"()));
CREATE POLICY "order_update_authenticated" ON "public"."order" FOR UPDATE TO "authenticated" USING (("created_by" = "auth"."uid"())) WITH CHECK (("created_by" = "auth"."uid"()));
ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own role" ON "public"."user_roles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."drawer";
GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";
GRANT ALL ON TABLE "public"."customer" TO "anon";
GRANT ALL ON TABLE "public"."customer" TO "authenticated";
GRANT ALL ON TABLE "public"."customer" TO "service_role";
GRANT ALL ON TABLE "public"."drawer" TO "anon";
GRANT ALL ON TABLE "public"."drawer" TO "authenticated";
GRANT ALL ON TABLE "public"."drawer" TO "service_role";
GRANT ALL ON TABLE "public"."drawer_backup_2026_05_02" TO "anon";
GRANT ALL ON TABLE "public"."drawer_backup_2026_05_02" TO "authenticated";
GRANT ALL ON TABLE "public"."drawer_backup_2026_05_02" TO "service_role";
GRANT ALL ON TABLE "public"."employee" TO "anon";
GRANT ALL ON TABLE "public"."employee" TO "authenticated";
GRANT ALL ON TABLE "public"."employee" TO "service_role";
GRANT ALL ON TABLE "public"."order" TO "anon";
GRANT ALL ON TABLE "public"."order" TO "authenticated";
GRANT ALL ON TABLE "public"."order" TO "service_role";
GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role"