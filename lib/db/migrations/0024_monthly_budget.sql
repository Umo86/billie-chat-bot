ALTER TABLE "settings" ADD COLUMN "monthly_budget_cents" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "budget_hard_stop" boolean DEFAULT false NOT NULL;