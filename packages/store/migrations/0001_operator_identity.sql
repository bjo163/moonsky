CREATE TABLE "moonsky"."operator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moonsky"."operator_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role" varchar(16) DEFAULT 'admin' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_users_role_check" CHECK ("moonsky"."operator_users"."role" in ('admin', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "moonsky"."operator_sessions" ADD CONSTRAINT "operator_sessions_operator_id_operator_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "moonsky"."operator_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_sessions_token_unique" ON "moonsky"."operator_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_sessions_operator_idx" ON "moonsky"."operator_sessions" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_sessions_expiry_idx" ON "moonsky"."operator_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_users_login_unique" ON "moonsky"."operator_users" USING btree ("login");