ALTER TABLE "chat_requests" ADD COLUMN "exhibitor_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD COLUMN "order" jsonb;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD CONSTRAINT "chat_requests_exhibitor_id_exhibitors_id_fk" FOREIGN KEY ("exhibitor_id") REFERENCES "public"."exhibitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_requests_exhibitor_idx" ON "chat_requests" USING btree ("exhibitor_id","type_id");