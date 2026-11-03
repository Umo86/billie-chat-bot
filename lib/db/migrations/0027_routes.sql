ALTER TABLE "bots" ADD COLUMN "routes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "routed_to" uuid;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_routed_to_users_id_fk" FOREIGN KEY ("routed_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;