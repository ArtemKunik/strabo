CREATE VIEW order_totals AS
WITH recent AS (SELECT * FROM orders)
SELECT u.email, r.total
FROM recent r
JOIN users u ON u.id = r.user_id;
