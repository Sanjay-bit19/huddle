CREATE TABLE "activity_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"card_id" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_search" (
	"board_id" uuid NOT NULL,
	"card_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"labels" text NOT NULL,
	"column_title" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(labels, '')), 'B') || setweight(to_tsvector('english', coalesce(body, '')), 'C')) STORED,
	CONSTRAINT "card_search_board_id_card_id_pk" PRIMARY KEY("board_id","card_id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"card_id" text NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_search" ADD CONSTRAINT "card_search_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_search" ADD CONSTRAINT "card_search_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_board_idx" ON "activity_events" USING btree ("board_id","id");--> statement-breakpoint
CREATE INDEX "activity_card_idx" ON "activity_events" USING btree ("board_id","card_id","id");--> statement-breakpoint
CREATE INDEX "card_search_document_idx" ON "card_search" USING gin ("document");--> statement-breakpoint
CREATE INDEX "card_search_workspace_idx" ON "card_search" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "comments_card_idx" ON "comments" USING btree ("board_id","card_id","created_at");