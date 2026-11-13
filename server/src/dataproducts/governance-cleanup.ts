import { db } from '../db.js';
import { chunks, marks } from './store.js';

/**
 * What consumers, access and governance (0.24.0) keep of a product and its ports, removed with them – called inside
 * the deleting transaction (service.deleteProduct, ports.deletePort, ports.removeConsumer). Approved port access
 * reviews and decided requests are evidence: their rows stay in the audit log's entries, the tables let them go with
 * the product.
 */
export function forgetGovernance(o: { productId?: string; portIds?: readonly string[]; consumerIds?: readonly string[] }): void {
  for (const part of chunks([...(o.consumerIds ?? [])])) db().run(`DELETE FROM dp_consumer_identities WHERE consumer_id IN (${marks(part.length)})`, ...part);
  for (const part of chunks([...(o.portIds ?? [])])) {
    const m = marks(part.length);
    db().run(`DELETE FROM dp_consumer_identities WHERE consumer_id IN (SELECT id FROM dp_consumers WHERE port_id IN (${m}))`, ...part);
    db().run(`DELETE FROM dp_actual_reads WHERE port_id IN (${m})`, ...part);
    db().run(`DELETE FROM dp_actual_consumers WHERE port_id IN (${m})`, ...part);
    db().run(`DELETE FROM dp_access_requests WHERE port_id IN (${m})`, ...part);
    db().run(`DELETE FROM dp_port_review_items WHERE review_id IN (SELECT id FROM dp_port_reviews WHERE port_id IN (${m}))`, ...part);
    db().run(`DELETE FROM dp_port_reviews WHERE port_id IN (${m})`, ...part);
  }
  if (o.productId) {
    db().run('DELETE FROM dp_access_settings WHERE product_id = ?', o.productId);
    db().run('DELETE FROM dp_promotions WHERE product_id = ?', o.productId);
    db().run('DELETE FROM dp_endorsements WHERE product_id = ?', o.productId);
    db().run("DELETE FROM dp_notices WHERE kind = 'endorsement' AND item_id = ?", o.productId);
  }
}
