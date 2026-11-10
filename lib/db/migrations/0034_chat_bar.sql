CREATE TYPE "public"."bar_mascot" AS ENUM('robot', 'picture', 'none');--> statement-breakpoint
CREATE TYPE "public"."launcher_style" AS ENUM('button', 'bar');--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "launcher_style" "launcher_style" DEFAULT 'button' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "bar_lead" text DEFAULT 'Ask me about' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "bar_topics" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "bar_mascot" "bar_mascot" DEFAULT 'robot' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "bar_motion" boolean DEFAULT true NOT NULL;