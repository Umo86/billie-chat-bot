CREATE TABLE "blueprint_links" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"signing_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	CONSTRAINT "blueprint_links_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
ALTER TABLE "exhibitor_lists" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "exhibitors" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "blueprint_links" ADD CONSTRAINT "blueprint_links_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_links" ADD CONSTRAINT "blueprint_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exhibitors_bot_external_idx" ON "exhibitors" USING btree ("bot_id","external_id");