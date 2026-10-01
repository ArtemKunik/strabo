-- A single recorded table, so the Data layer has a dataset for the code's reads and writes.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  total INTEGER NOT NULL
);
