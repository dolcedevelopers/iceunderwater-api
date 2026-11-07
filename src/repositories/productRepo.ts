import type { RowDataPacket } from "mysql2";
import { execute, query } from "../db/pool.js";

export type ProductOwnerRow = RowDataPacket & {
  wc_product_id: number;
  supplier_id: string;
  deleted_at: Date | null;
};

export async function listOwnedProductIds(supplierId?: string | null): Promise<ProductOwnerRow[]> {
  if (supplierId) {
    return query<ProductOwnerRow[]>(
      `SELECT * FROM iuw_product_owners WHERE supplier_id = :supplierId AND deleted_at IS NULL`,
      { supplierId },
    );
  }
  return query<ProductOwnerRow[]>(`SELECT * FROM iuw_product_owners WHERE deleted_at IS NULL`);
}

export async function findProductOwner(wcProductId: number): Promise<ProductOwnerRow | null> {
  const rows = await query<ProductOwnerRow[]>(
    `SELECT * FROM iuw_product_owners WHERE wc_product_id = :wcProductId AND deleted_at IS NULL LIMIT 1`,
    { wcProductId },
  );
  return rows[0] || null;
}

/**
 * Active suppliers that stock the requested product, or anything in its
 * `product_cat` terms. Keeps an ice request away from a clothing company.
 */
export async function listSupplierIdsForProductCategory(wcProductId: number): Promise<string[]> {
  const rows = await query<(RowDataPacket & { supplier_id: string })[]>(
    `SELECT DISTINCT po.supplier_id AS supplier_id
       FROM iuw_product_owners po
       INNER JOIN wp_posts p ON p.ID = po.wc_product_id
       INNER JOIN iuw_suppliers s ON s.id = po.supplier_id
       INNER JOIN wp_term_relationships tr ON tr.object_id = p.ID
       INNER JOIN wp_term_taxonomy tt
         ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_cat'
      WHERE po.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND s.status = 'active'
        AND p.post_type = 'product'
        AND p.post_status = 'publish'
        AND tt.term_taxonomy_id IN (
          SELECT tr2.term_taxonomy_id
            FROM wp_term_relationships tr2
            INNER JOIN wp_term_taxonomy tt2
              ON tt2.term_taxonomy_id = tr2.term_taxonomy_id AND tt2.taxonomy = 'product_cat'
           WHERE tr2.object_id = :wcProductId
        )`,
    { wcProductId },
  );
  return rows.map((row) => row.supplier_id);
}

export async function upsertProductOwner(wcProductId: number, supplierId: string): Promise<void> {
  await execute(
    `INSERT INTO iuw_product_owners (wc_product_id, supplier_id)
     VALUES (:wcProductId, :supplierId)
     ON DUPLICATE KEY UPDATE supplier_id = VALUES(supplier_id), deleted_at = NULL`,
    { wcProductId, supplierId },
  );
}

export async function softDeleteProductOwner(wcProductId: number): Promise<void> {
  await execute(
    `UPDATE iuw_product_owners SET deleted_at = UTC_TIMESTAMP(3) WHERE wc_product_id = :wcProductId`,
    { wcProductId },
  );
}

/** Read path: join Woo posts/meta via SQL for speed. Never write wp_* from here. */
export async function listProductsFromWp(filter: {
  supplierId?: string | null;
  publicOnly?: boolean;
  productId?: number;
}): Promise<
  (RowDataPacket & {
    id: number;
    supplier_id: string;
    name: string;
    category: string;
    price_cents: number;
    cost_cents: number;
    markup_percent: number;
    stock: number;
    description: string;
    image: string;
    active: number;
    unit: string;
    in_stock: number;
    has_options: number;
  })[]
> {
  const clauses = ["po.deleted_at IS NULL", "p.post_type = 'product'", "p.post_status IN ('publish','draft','private')"];
  if (!filter.publicOnly) clauses.push("po.wc_product_id IS NOT NULL");
  const params: Record<string, unknown> = {};

  if (filter.supplierId) {
    clauses.push("po.supplier_id = :supplierId");
    params.supplierId = filter.supplierId;
  }
  if (filter.productId) {
    clauses.push("p.ID = :productId");
    params.productId = filter.productId;
  }
  if (filter.publicOnly) {
    clauses.push("p.post_status = 'publish'");
    clauses.push("(po.supplier_id IS NULL OR (s.status = 'active' AND s.deleted_at IS NULL))");
    clauses.push(`NOT EXISTS (SELECT 1 FROM wp_term_relationships vr
      JOIN wp_term_taxonomy vt ON vt.term_taxonomy_id = vr.term_taxonomy_id
      JOIN wp_terms v ON v.term_id = vt.term_id
      WHERE vr.object_id = p.ID AND vt.taxonomy = 'product_visibility' AND v.slug = 'exclude-from-catalog')`);
  }

  return query(
    `SELECT
      p.ID AS id,
      COALESCE(po.supplier_id, '') AS supplier_id,
      p.post_title AS name,
      COALESCE(tax.name, '') AS category,
      CAST(ROUND(CAST(COALESCE(price.meta_value, '0') AS DECIMAL(20,4)) * 100) AS SIGNED) AS price_cents,
      CAST(
        COALESCE(
          NULLIF(cost.meta_value, ''),
          ROUND(CAST(COALESCE(price.meta_value, '0') AS DECIMAL(20,4)) * 100)
        ) AS SIGNED
      ) AS cost_cents,
      CAST(COALESCE(s.markup_percent, 0) AS DECIMAL(8,2)) AS markup_percent,
      CAST(COALESCE(stock.meta_value, '0') AS SIGNED) AS stock,
      COALESCE(NULLIF(p.post_excerpt, ''), p.post_content, '') AS description,
      COALESCE(
        NULLIF(imgurl.meta_value, ''),
        CASE
          WHEN file.meta_value IS NOT NULL AND file.meta_value <> '' THEN
            CONCAT(
              TRIM(TRAILING '/' FROM REPLACE(COALESCE(site.option_value, ''), 'http://', 'https://')),
              '/wp-content/uploads/',
              file.meta_value
            )
          ELSE REPLACE(COALESCE(img.guid, ''), 'http://', 'https://')
        END,
        ''
      ) AS image,
      CASE WHEN p.post_status = 'publish' THEN 1 ELSE 0 END AS active,
      COALESCE(unit.meta_value, '') AS unit,
      CASE WHEN COALESCE(stockstatus.meta_value, 'instock') = 'outofstock' THEN 0 ELSE 1 END AS in_stock,
      CASE WHEN EXISTS (SELECT 1 FROM wp_term_relationships pr
        JOIN wp_term_taxonomy pt ON pt.term_taxonomy_id = pr.term_taxonomy_id
        JOIN wp_terms term ON term.term_id = pt.term_id
        WHERE pr.object_id = p.ID AND pt.taxonomy = 'product_type' AND term.slug IN ('variable','grouped')) THEN 1 ELSE 0 END AS has_options
     FROM wp_posts p
     LEFT JOIN iuw_product_owners po ON p.ID = po.wc_product_id
     LEFT JOIN iuw_suppliers s ON s.id = po.supplier_id
     LEFT JOIN wp_postmeta price ON price.post_id = p.ID AND price.meta_key = '_price'
     LEFT JOIN wp_postmeta cost ON cost.post_id = p.ID AND cost.meta_key = '_iuw_cost_cents'
     LEFT JOIN wp_postmeta stock ON stock.post_id = p.ID AND stock.meta_key = '_stock'
     LEFT JOIN wp_postmeta stockstatus ON stockstatus.post_id = p.ID AND stockstatus.meta_key = '_stock_status'
     LEFT JOIN wp_postmeta unit ON unit.post_id = p.ID AND unit.meta_key = '_iuw_unit'
     LEFT JOIN wp_postmeta imgurl ON imgurl.post_id = p.ID AND imgurl.meta_key = '_iuw_image_url'
     LEFT JOIN wp_postmeta thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
     LEFT JOIN wp_posts img ON img.ID = thumb.meta_value
     LEFT JOIN wp_postmeta file ON file.post_id = img.ID AND file.meta_key = '_wp_attached_file'
     LEFT JOIN wp_options site ON site.option_name = 'siteurl'
     LEFT JOIN (
       SELECT tr.object_id, MIN(t.name) AS name
       FROM wp_term_relationships tr
       INNER JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_cat'
       INNER JOIN wp_terms t ON t.term_id = tt.term_id
       GROUP BY tr.object_id
     ) tax ON tax.object_id = p.ID
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.post_title ASC`,
    params,
  );
}
