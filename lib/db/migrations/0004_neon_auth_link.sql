ALTER TABLE "users" ADD COLUMN "auth_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "linked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_user_id_unique" ON "users" USING btree ("auth_user_id");