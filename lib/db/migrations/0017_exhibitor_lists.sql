CREATE TABLE "exhibitor_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"exhibitor_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exhibitor_lists" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exhibitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"stand" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"emails" text[] DEFAULT '{}' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "personal_answers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "exhibitor_id" uuid;--> statement-breakpoint
ALTER TABLE "exhibitor_codes" ADD CONSTRAINT "exhibitor_codes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exhibitor_codes" ADD CONSTRAINT "exhibitor_codes_exhibitor_id_exhibitors_id_fk" FOREIGN KEY ("exhibitor_id") REFERENCES "public"."exhibitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exhibitor_lists" ADD CONSTRAINT "exhibitor_lists_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exhibitor_lists" ADD CONSTRAINT "exhibitor_lists_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exhibitors" ADD CONSTRAINT "exhibitors_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exhibitor_codes_conversation_idx" ON "exhibitor_codes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "exhibitor_codes_exhibitor_idx" ON "exhibitor_codes" USING btree ("exhibitor_id");--> statement-breakpoint
CREATE INDEX "exhibitors_bot_idx" ON "exhibitors" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "exhibitors_emails_idx" ON "exhibitors" USING gin ("emails");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_exhibitor_id_exhibitors_id_fk" FOREIGN KEY ("exhibitor_id") REFERENCES "public"."exhibitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_exhibitor_idx" ON "conversations" USING btree ("exhibitor_id");