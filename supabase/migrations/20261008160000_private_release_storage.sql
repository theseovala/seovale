BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES ('license-releases', 'license-releases', false)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'license-releases' AND public = true
  ) THEN
    RAISE EXCEPTION 'license-releases must be private; review existing downloads before changing bucket access';
  END IF;
END
$$;

COMMIT;
