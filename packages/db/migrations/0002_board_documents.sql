CREATE TABLE "board_documents" (
	"board_id" uuid PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"compacted_updates" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"update" "bytea" NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_documents" ADD CONSTRAINT "board_documents_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_updates" ADD CONSTRAINT "board_updates_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_updates_board_idx" ON "board_updates" USING btree ("board_id","id");