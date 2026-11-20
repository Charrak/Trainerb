-- Editorial links supplement (never replace) system and legal navigation.
CREATE TABLE navigation_menus (
  location text PRIMARY KEY CHECK(location IN ('header','footer')),
  revision int NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO navigation_menus(location) VALUES ('header'),('footer');
CREATE TABLE navigation_items (
  location text NOT NULL REFERENCES navigation_menus(location) ON DELETE RESTRICT,
  position int NOT NULL CHECK(position BETWEEN 1 AND 12),
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 60),
  visible boolean NOT NULL,
  PRIMARY KEY(location,position), UNIQUE(location,page_id)
);
