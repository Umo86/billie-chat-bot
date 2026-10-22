DROP TABLE "auth_account" CASCADE;--> statement-breakpoint
DROP TABLE "auth_session" CASCADE;--> statement-breakpoint
DROP TABLE "auth_verification" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email_verified";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "image";