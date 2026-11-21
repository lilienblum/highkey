-- website_url remains the first concrete address, used for page links and the cached icon.
ALTER TABLE products ADD COLUMN website_urls TEXT;
UPDATE products SET website_urls=json_array(website_url),
  website_url=CASE WHEN instr(website_url,'*')=0 THEN website_url END
  WHERE website_url IS NOT NULL;
