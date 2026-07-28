-- 049_text_status.sql — WhatsApp text status (no attachment, just text + color).

ALTER TABLE stories ADD COLUMN IF NOT EXISTS text_content TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS bg_color     TEXT;

-- Text stories carry no attachment / media_type, so relax those NOT NULLs.
ALTER TABLE stories ALTER COLUMN attachment_id DROP NOT NULL;
ALTER TABLE stories ALTER COLUMN media_type    DROP NOT NULL;
