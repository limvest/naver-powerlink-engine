CREATE TABLE "ad_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"entity_id" uuid NOT NULL,
	"day" text NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ad_stats_entity_day" UNIQUE("entity_id","day")
);
--> statement-breakpoint
CREATE TABLE "firm_ad_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"keyword_id" uuid,
	"variant_id" uuid,
	"naver_id" text NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_ad_entities_firm_type_naver" UNIQUE("firm_id","entity_type","naver_id")
);
--> statement-breakpoint
CREATE TABLE "firm_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"provider" text DEFAULT 'naver_searchad' NOT NULL,
	"customer_id" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"secret_enc" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_credentials_firm_provider" UNIQUE("firm_id","provider")
);
--> statement-breakpoint
CREATE TABLE "firm_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"keyword_id" uuid NOT NULL,
	"status" text DEFAULT 'subscribed' NOT NULL,
	"naver_adgroup_id" text,
	"last_error" text,
	"ad_desired" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"public_host_label" text,
	"host_status" text DEFAULT 'pending' NOT NULL,
	"host_key_version" integer DEFAULT 1 NOT NULL,
	"host_published_at" timestamp with time zone,
	"host_redirected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_keywords_firm_keyword" UNIQUE("firm_id","keyword_id"),
	CONSTRAINT "firm_keywords_firm_public_host" UNIQUE("firm_id","public_host_label")
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"ad_lawyer_name" text NOT NULL,
	"phone" text NOT NULL,
	"phone_intl" text NOT NULL,
	"address" text NOT NULL,
	"address_region" text NOT NULL,
	"address_locality" text NOT NULL,
	"kakao_url" text,
	"domain" text,
	"domain_aliases" jsonb,
	"status" text DEFAULT 'pilot' NOT NULL,
	"plan_note" text,
	"lawyers" jsonb,
	"wordmark" text,
	"landing_ready" boolean DEFAULT false NOT NULL,
	"dashboard_token" text,
	"site_template" text DEFAULT 'response-room' NOT NULL,
	"profile_intro" text,
	"office_history" jsonb,
	"ad_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firms_slug_unique" UNIQUE("slug"),
	CONSTRAINT "firms_domain_unique" UNIQUE("domain"),
	CONSTRAINT "firms_dashboard_token_unique" UNIQUE("dashboard_token")
);
--> statement-breakpoint
CREATE TABLE "keyword_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword_id" uuid NOT NULL,
	"text" text NOT NULL,
	"rule" text NOT NULL,
	"rule_version" text DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_variants_keyword_text" UNIQUE("keyword_id","text")
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"aliases" jsonb,
	"scam_type" text NOT NULL,
	"source_url" text,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"status" text DEFAULT 'published' NOT NULL,
	"managed_by" text DEFAULT 'curated' NOT NULL,
	"auto_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keywords_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "naver_auto_bid_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"command" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb,
	"requested_by" text NOT NULL,
	"error" text,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "naver_auto_bid_commands_idempotency" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "naver_auto_bid_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"keyword_id" uuid,
	"firm_keyword_id" uuid,
	"firm_ad_entity_id" uuid,
	"naver_keyword_id" text NOT NULL,
	"device" text DEFAULT 'mobile' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"before_bid" integer,
	"estimated_bid" integer,
	"target_bid" integer,
	"after_bid" integer,
	"before_use_group_bid" boolean,
	"after_use_group_bid" boolean,
	"reason" text,
	"cooldown_until" timestamp with time zone,
	"raw" jsonb,
	"request_raw" jsonb,
	"response_raw" jsonb,
	"error" text,
	"verification_status" text DEFAULT 'not_started' NOT NULL,
	"verification_error" text,
	"verification_raw" jsonb,
	"verified_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "naver_auto_bid_decisions_run_keyword" UNIQUE("run_id","naver_keyword_id")
);
--> statement-breakpoint
CREATE TABLE "naver_auto_bid_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"run_id" uuid,
	"decision_id" uuid,
	"naver_campaign_id" text,
	"naver_adgroup_id" text,
	"naver_keyword_id" text,
	"campaign_name" text,
	"adgroup_name" text,
	"keyword" text,
	"event_type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"before_rank" integer,
	"after_rank" integer,
	"target_position" integer,
	"before_bid" integer,
	"after_bid" integer,
	"message" text NOT NULL,
	"actor" text DEFAULT 'auto-bid-engine' NOT NULL,
	"correlation_key" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "naver_auto_bid_group_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"naver_campaign_id" text NOT NULL,
	"naver_adgroup_id" text NOT NULL,
	"campaign_name" text,
	"adgroup_name" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"device" text DEFAULT 'mobile' NOT NULL,
	"target_position" integer,
	"bid_floor" integer,
	"bid_ceiling" integer,
	"step_up" integer,
	"step_down" integer,
	"schedule" jsonb,
	"block_reason" text,
	"keyword_count" integer DEFAULT 0 NOT NULL,
	"enabled_keyword_count" integer DEFAULT 0 NOT NULL,
	"spend_7d" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "naver_auto_bid_group_policies_firm_group" UNIQUE("firm_id","naver_adgroup_id")
);
--> statement-breakpoint
CREATE TABLE "naver_auto_bid_keyword_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"naver_adgroup_id" text NOT NULL,
	"naver_keyword_id" text NOT NULL,
	"keyword" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"target_position" integer,
	"bid_floor" integer,
	"bid_ceiling" integer,
	"step_up" integer,
	"step_down" integer,
	"last_observed_rank" integer,
	"last_observed_status" text,
	"last_observed_bid" integer,
	"last_visible_ads" integer,
	"last_observed_at" timestamp with time zone,
	"legal_competitor_present" boolean DEFAULT false NOT NULL,
	"legal_competitor_count" integer DEFAULT 0 NOT NULL,
	"legal_competitors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"found_count" integer DEFAULT 0 NOT NULL,
	"outside_count" integer DEFAULT 0 NOT NULL,
	"no_ads_count" integer DEFAULT 0 NOT NULL,
	"consecutive_status_count" integer DEFAULT 0 NOT NULL,
	"observation_window" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bid_learning" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_estimated_bid" integer,
	"last_changed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "naver_auto_bid_keyword_policies_firm_keyword" UNIQUE("firm_id","naver_keyword_id")
);
--> statement-breakpoint
CREATE TABLE "naver_auto_bid_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"policy_version" text DEFAULT 'naver-auto-bid-v1' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"strategy" text DEFAULT 'observed_rank' NOT NULL,
	"device" text DEFAULT 'mobile' NOT NULL,
	"target_position" integer DEFAULT 3 NOT NULL,
	"bid_floor" integer DEFAULT 70 NOT NULL,
	"bid_ceiling" integer,
	"step_up" integer DEFAULT 100 NOT NULL,
	"step_down" integer DEFAULT 100 NOT NULL,
	"allow_bid_decrease" boolean DEFAULT true NOT NULL,
	"exposure_buffer" integer DEFAULT 10 NOT NULL,
	"cooldown_minutes" integer DEFAULT 360 NOT NULL,
	"batch_size" integer DEFAULT 50 NOT NULL,
	"max_changes_per_run" integer,
	"schedule" jsonb DEFAULT '{"timezone":"Asia/Seoul","weekdays":[0,1,2,3,4,5,6],"start":"08:00","end":"22:00"}'::jsonb NOT NULL,
	"consecutive_failure_limit" integer DEFAULT 3 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "naver_auto_bid_policies_firm" UNIQUE("firm_id")
);
--> statement-breakpoint
CREATE TABLE "naver_auto_bid_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"policy_id" uuid,
	"run_key" text NOT NULL,
	"active_key" text,
	"status" text DEFAULT 'running' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"device" text DEFAULT 'mobile' NOT NULL,
	"raw" jsonb,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"changed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"verification_status" text DEFAULT 'not_started' NOT NULL,
	"verification_error" text,
	"verification_raw" jsonb,
	"verified_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "naver_auto_bid_runs_firm_run_key" UNIQUE("firm_id","run_key"),
	CONSTRAINT "naver_auto_bid_runs_active_key" UNIQUE("active_key")
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_url" text,
	"source_type" text,
	"title" text,
	"origin" text,
	"source_family" text,
	"facts" jsonb,
	CONSTRAINT "observations_keyword_source_url" UNIQUE("keyword_id","source_url")
);
--> statement-breakpoint
ALTER TABLE "ad_stats" ADD CONSTRAINT "ad_stats_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_stats" ADD CONSTRAINT "ad_stats_entity_id_firm_ad_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."firm_ad_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_ad_entities" ADD CONSTRAINT "firm_ad_entities_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_ad_entities" ADD CONSTRAINT "firm_ad_entities_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_ad_entities" ADD CONSTRAINT "firm_ad_entities_variant_id_keyword_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."keyword_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_credentials" ADD CONSTRAINT "firm_credentials_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD CONSTRAINT "firm_keywords_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD CONSTRAINT "firm_keywords_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_variants" ADD CONSTRAINT "keyword_variants_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_commands" ADD CONSTRAINT "naver_auto_bid_commands_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_decisions" ADD CONSTRAINT "naver_auto_bid_decisions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_decisions" ADD CONSTRAINT "naver_auto_bid_decisions_run_id_naver_auto_bid_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."naver_auto_bid_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_decisions" ADD CONSTRAINT "naver_auto_bid_decisions_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_decisions" ADD CONSTRAINT "naver_auto_bid_decisions_firm_keyword_id_firm_keywords_id_fk" FOREIGN KEY ("firm_keyword_id") REFERENCES "public"."firm_keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_decisions" ADD CONSTRAINT "naver_auto_bid_decisions_firm_ad_entity_id_firm_ad_entities_id_fk" FOREIGN KEY ("firm_ad_entity_id") REFERENCES "public"."firm_ad_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_events" ADD CONSTRAINT "naver_auto_bid_events_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_events" ADD CONSTRAINT "naver_auto_bid_events_run_id_naver_auto_bid_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."naver_auto_bid_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_events" ADD CONSTRAINT "naver_auto_bid_events_decision_id_naver_auto_bid_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."naver_auto_bid_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_group_policies" ADD CONSTRAINT "naver_auto_bid_group_policies_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_keyword_policies" ADD CONSTRAINT "naver_auto_bid_keyword_policies_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_policies" ADD CONSTRAINT "naver_auto_bid_policies_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_runs" ADD CONSTRAINT "naver_auto_bid_runs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "naver_auto_bid_runs" ADD CONSTRAINT "naver_auto_bid_runs_policy_id_naver_auto_bid_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."naver_auto_bid_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_keywords_firm_archived_idx" ON "firm_keywords" USING btree ("firm_id","archived_at");--> statement-breakpoint
CREATE INDEX "keywords_normalized_name_idx" ON "keywords" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_commands_status_created_idx" ON "naver_auto_bid_commands" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_commands_firm_created_idx" ON "naver_auto_bid_commands" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_decisions_firm_run_status_idx" ON "naver_auto_bid_decisions" USING btree ("firm_id","run_id","status");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_decisions_firm_keyword_created_idx" ON "naver_auto_bid_decisions" USING btree ("firm_id","keyword_id","created_at");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_decisions_firm_cooldown_idx" ON "naver_auto_bid_decisions" USING btree ("firm_id","cooldown_until");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_decisions_firm_verification_idx" ON "naver_auto_bid_decisions" USING btree ("firm_id","verification_status");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_events_firm_created_idx" ON "naver_auto_bid_events" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_events_firm_type_created_idx" ON "naver_auto_bid_events" USING btree ("firm_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_events_keyword_created_idx" ON "naver_auto_bid_events" USING btree ("firm_id","naver_keyword_id","created_at");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_events_correlation_idx" ON "naver_auto_bid_events" USING btree ("correlation_key");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_group_policies_firm_enabled_idx" ON "naver_auto_bid_group_policies" USING btree ("firm_id","enabled","naver_adgroup_id");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_keyword_policies_group_enabled_idx" ON "naver_auto_bid_keyword_policies" USING btree ("firm_id","naver_adgroup_id","enabled");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_keyword_policies_keyword_search_idx" ON "naver_auto_bid_keyword_policies" USING btree ("firm_id","keyword");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_keyword_policies_rank_state_idx" ON "naver_auto_bid_keyword_policies" USING btree ("firm_id","last_observed_status","last_observed_rank");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_keyword_policies_legal_competitor_idx" ON "naver_auto_bid_keyword_policies" USING btree ("firm_id","legal_competitor_present");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_policies_firm_status_idx" ON "naver_auto_bid_policies" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_runs_firm_status_created_idx" ON "naver_auto_bid_runs" USING btree ("firm_id","status","created_at");--> statement-breakpoint
CREATE INDEX "naver_auto_bid_runs_firm_active_idx" ON "naver_auto_bid_runs" USING btree ("firm_id","active_key");--> statement-breakpoint
CREATE INDEX "observations_source_family_url_idx" ON "observations" USING btree ("source_family","source_url");