-- 052_story_text_check.sql — allow text statuses.
--
-- 020_stories created stories.media_type with CHECK (media_type IN ('image','video')),
-- and 049 only dropped the NOT NULL — so inserting a text status (media_type='text')
-- still violated the CHECK and failed ("failed to upload status"). Relax the CHECK
-- to allow NULL/'text' too.

ALTER TABLE stories DROP CONSTRAINT IF EXISTS stories_media_type_check;
ALTER TABLE stories
  ADD CONSTRAINT stories_media_type_check
  CHECK (media_type IS NULL OR media_type IN ('image','video','text'));
