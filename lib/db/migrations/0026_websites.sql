CREATE TABLE "websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"leave_out" text[] DEFAULT '{}' NOT NULL,
	"max_pages" integer DEFAULT 200 NOT NULL,
	"status" text DEFAULT 'finding' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"last_crawled_at" timestamp with time zone,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "website_id" uuid;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "websites_kb_idx" ON "websites" USING btree ("knowledge_base_id");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_website_idx" ON "sources" USING btree ("website_id");