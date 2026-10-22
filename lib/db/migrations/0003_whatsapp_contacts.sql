CREATE TABLE "whatsapp_contacts" (
	"wa_id" text PRIMARY KEY NOT NULL,
	"profile_name" text DEFAULT '' NOT NULL,
	"bot_id" uuid,
	"pending_text" text,
	"last_inbound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_contacts_bot_idx" ON "whatsapp_contacts" USING btree ("bot_id");