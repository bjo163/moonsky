CREATE TABLE "moonsky"."channel_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"external_account_id" varchar(255) NOT NULL,
	"display_name" varchar(160),
	"auth_ref" varchar(512) NOT NULL,
	"status" varchar(24) DEFAULT 'disconnected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_accounts_status_check" CHECK ("moonsky"."channel_accounts"."status" in ('disconnected', 'pairing', 'connected', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "moonsky"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"title" varchar(255),
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_status_check" CHECK ("moonsky"."conversations"."status" in ('open', 'closed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "moonsky"."delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" varchar(24) NOT NULL,
	"provider_message_id" varchar(255),
	"error_code" varchar(100),
	"error_summary" varchar(500),
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_number_positive_check" CHECK ("moonsky"."delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "delivery_attempts_status_check" CHECK ("moonsky"."delivery_attempts"."status" in ('pending', 'accepted', 'delivered', 'failed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "moonsky"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_message_id" varchar(255),
	"direction" varchar(12) NOT NULL,
	"sender_id" varchar(255),
	"body" text NOT NULL,
	"status" varchar(24) DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_direction_check" CHECK ("moonsky"."messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_status_check" CHECK ("moonsky"."messages"."status" in ('received', 'pending', 'accepted', 'delivered', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "moonsky"."conversations" ADD CONSTRAINT "conversations_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "moonsky"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moonsky"."delivery_attempts" ADD CONSTRAINT "delivery_attempts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "moonsky"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moonsky"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "moonsky"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_accounts_provider_external_unique" ON "moonsky"."channel_accounts" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_account_external_unique" ON "moonsky"."conversations" USING btree ("channel_account_id","external_id");--> statement-breakpoint
CREATE INDEX "conversations_account_recent_idx" ON "moonsky"."conversations" USING btree ("channel_account_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_message_number_unique" ON "moonsky"."delivery_attempts" USING btree ("message_id","attempt_number");--> statement-breakpoint
CREATE INDEX "delivery_attempts_recent_idx" ON "moonsky"."delivery_attempts" USING btree ("message_id","attempted_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_external_unique" ON "moonsky"."messages" USING btree ("conversation_id","external_message_id") WHERE "moonsky"."messages"."external_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_recent_idx" ON "moonsky"."messages" USING btree ("conversation_id","created_at","id");