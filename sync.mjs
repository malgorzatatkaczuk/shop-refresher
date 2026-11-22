// shop-refresher: synchronizacja produktów LaBalancia -> sklep Shopify Maviie.
//
// 1. Czyta arkusz Google (zakładka "Kalkulacja"): wiersze z Producent = La Balancia,
//    kolumny "Model" (nazwa w sklepie), "nazwa producenta" (nazwa w XML) i "Cena MAX".
// 2. Czyta feed XML LaBalancii: rozmiary, SKU (EAN) i ilości.
// 3. W Shopify:
//    - produktu jeszcze nie ma -> tworzy go jako WERSJĘ ROBOCZĄ (bez zdjęć),
//    - produkt jest -> aktualizuje ilości, dodaje nowe rozmiary, brakujące ustawia na 0,
//      poprawia cenę, jeśli zmieniła się w arkuszu.
//    Niczego nie usuwa i nie zmienia zdjęć, opisów ani statusu produktu.
//
// Bez zależności - wymaga Node.js 20+.

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const env = process.env;
const DRY_RUN = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
const API_VERSION = env.SHOPIFY_API_VERSION || '2026-10';
const STOCK_BUFFER = Math.max(0, parseInt(env.STOCK_BUFFER || '0', 10) || 0);
const SHEET_RANGE = env.SHEET_RANGE || 'Kalkulacja!A1:Z';
const PRODUCER_MATCH = (env.PRODUCER_MATCH || 'balancia').toLowerCase();
const VENDOR = env.SHOPIFY_VENDOR || 'LaBalancia';
const TAG = env.SHOPIFY_TAG || 'LaBalancia';
const SIZE_OPTION = 'Rozmiar';
const SIZE_NAMES = { UNI: 'Uniwersalny' };

const log = (...a) => console.log(...a);

// ---------- helpers ----------
const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const sizeName = (s) => SIZE_NAMES[String(s).trim().toUpperCase()] || String(s).trim();
const SIZE_ORDER = ['XXS', 'XS', 'XS/S', 'S', 'S/M', 'M', 'M/L', 'L', 'L/XL', 'XL', 'XXL', 'UNIWERSALNY'];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };
function parsePrice(v) {
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.').replace(/zł/i, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}
function need(name) {
  if (!env[name]) throw new Error(`Brak zmiennej środowiskowej ${name}`);
  return env[name];
}

// ---------- Google Sheets ----------
async function googleToken() {
  const sa = JSON.parse(need('GOOGLE_SERVICE_ACCOUNT_JSON'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`Google: nie udało się zalogować (${JSON.stringify(j)})`);
  return j.access_token;
}

async function readSheetRows() {
  if (env.SHEET_JSON_FILE) return JSON.parse(await readFile(env.SHEET_JSON_FILE, 'utf8')); // test lokalny
  const token = await googleToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${need('SHEET_ID')}/values/${encodeURIComponent(SHEET_RANGE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(`Google Sheets: ${res.status} ${JSON.stringify(j.error || j)}`);
  return j.values || [];
}

function sheetProducts(rows) {
  const header = (rows[0] || []).map(norm);
  const col = (name) => header.findIndex((h) => h === norm(name));
  const iModel = col('Model'), iSrc = col('nazwa producenta'), iProd = col('Producent'), iPrice = col('Cena MAX');
  if ([iModel, iSrc, iProd, iPrice].some((i) => i < 0)) {
    throw new Error(`Arkusz: brak którejś z kolumn Model / nazwa producenta / Producent / Cena MAX (nagłówki: ${rows[0]})`);
  }
  const out = [];
  for (const r of rows.slice(1)) {
    if (!norm(r[iProd]).replace(/\s/g, '').includes(PRODUCER_MATCH)) continue;
    const title = String(r[iModel] ?? '').trim();
    const source = String(r[iSrc] ?? '').trim();
    if (!title || !source) continue;
    out.push({ title, source, price: parsePrice(r[iPrice]) });
  }
  return out;
}

// ---------- XML feed ----------
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m ? m[1].trim() : '';
};

async function readFeed() {
  const xml = env.FEED_FILE
    ? await readFile(env.FEED_FILE, 'utf8')
    : await fetch(need('FEED_URL')).then((r) => {
        if (!r.ok) throw new Error(`Feed XML: HTTP ${r.status}`);
        return r.text();
      });
  const products = new Map();
  for (const m of xml.matchAll(/<product>([\s\S]*?)<\/product>/g)) {
    const p = m[1].replace(/<body_html>[\s\S]*?<\/body_html>/, '');
    const title = tag(p, 'title');
    const variants = [];
    for (const v of p.matchAll(/<variant>([\s\S]*?)<\/variant>/g)) {
      const x = v[1];
      const qty = parseInt(tag(x, 'quantity'), 10);
      variants.push({
        size: sizeName(tag(x, 'title')),
        sku: tag(x, 'sku'),
        barcode: tag(x, 'barcode'),
        qty: Number.isFinite(qty) ? Math.max(0, qty) : 0,
        inStock: tag(x, 'in_stock') === 'in_stock',
      });
    }
    variants.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
    products.set(norm(title), { title, variants: variants.filter((v) => v.sku) });
  }
  if (!products.size) throw new Error('Feed XML: nie znaleziono żadnych produktów');
  return products;
}

// ---------- Shopify ----------
let shopifyToken = env.SHOPIFY_TOKEN;
async function getShopifyToken() {
  if (shopifyToken) return shopifyToken;
  // Aplikacja z Dev Dashboard: token z client credentials (ważny ok. 24 h)
  const res = await fetch(`https://${need('SHOPIFY_STORE')}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: need('SHOPIFY_CLIENT_ID'),
      client_secret: need('SHOPIFY_CLIENT_SECRET'),
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Shopify: nie udało się pobrać tokenu (${res.status} ${JSON.stringify(j)})`);
  return (shopifyToken = j.access_token);
}

async function gql(query, variables = {}) {
  const res = await fetch(`https://${need('SHOPIFY_STORE')}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getShopifyToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(`Shopify: ${JSON.stringify(j.errors)}`);
  const ue = Object.values(j.data || {}).flatMap((v) => v?.userErrors || []);
  if (ue.length) throw new Error(`Shopify: ${JSON.stringify(ue)}`);
  return j.data;
}

async function primaryLocation() {
  const d = await gql(`{ locations(first: 5) { nodes { id name isActive } } }`);
  const loc = d.locations.nodes.find((l) => l.isActive);
  if (!loc) throw new Error('Shopify: brak aktywnej lokalizacji magazynowej');
  return loc.id;
}

async function findProductBySkus(skus) {
  const q = skus.map((s) => `sku:${JSON.stringify(s)}`).join(' OR ');
  const d = await gql(
    `query($q: String!) { productVariants(first: 50, query: $q) { nodes { product { id } } } }`,
    { q },
  );
  const ids = [...new Set(d.productVariants.nodes.map((n) => n.product.id))];
  if (ids.length > 1) log(`  ! uwaga: SKU tego produktu są w kilku produktach Shopify (${ids.join(', ')}) - biorę pierwszy`);
  return ids[0] || null;
}

async function loadProduct(id, locationId) {
  const d = await gql(
    `query($id: ID!, $loc: ID!) { product(id: $id) {
      id title status
      options { id name optionValues { id name } }
      variants(first: 100) { nodes {
        id sku price title
        selectedOptions { name value }
        inventoryItem { id tracked inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } }
      } }
    } }`,
    { id, loc: locationId },
  );
  return d.product;
}

async function createProduct(item, feed, locationId) {
  const sizes = [...new Set(feed.variants.map((v) => v.size))];
  const input = {
    title: item.title,
    vendor: VENDOR,
    tags: [TAG],
    status: 'DRAFT',
    productOptions: [{ name: SIZE_OPTION, values: sizes.map((name) => ({ name })) }],
    variants: feed.variants.map((v) => ({
      optionValues: [{ optionName: SIZE_OPTION, name: v.size }],
      sku: v.sku,
      barcodes: v.barcode ? [{ value: v.barcode }] : undefined,
      price: item.price || '0.00',
      inventoryPolicy: 'DENY',
      inventoryItem: { tracked: true, requiresShipping: true },
      inventoryQuantities: [{ locationId, name: 'available', quantity: Math.max(0, v.qty - STOCK_BUFFER) }],
    })),
  };
  if (DRY_RUN) return log(`  [próba] utworzyłabym wersję roboczą "${item.title}" (${sizes.join(', ')}), cena ${item.price}`);
  const d = await gql(
    `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) { product { id } userErrors { field message } } }`,
    { input },
  );
  log(`  + utworzono wersję roboczą "${item.title}" (${sizes.join(', ')}) - ${d.productSet.product.id}`);
}

async function updateProduct(item, feed, productId, locationId) {
  const product = await loadProduct(productId, locationId);
  const bySku = new Map(product.variants.nodes.filter((v) => v.sku).map((v) => [v.sku, v]));
  const feedSkus = new Set(feed.variants.map((v) => v.sku));
  const setQty = [];
  const priceUpdates = [];
  const newVariants = [];

  for (const fv of feed.variants) {
    const target = Math.max(0, fv.qty - STOCK_BUFFER);
    const sv = bySku.get(fv.sku);
    if (!sv) { newVariants.push({ fv, target }); continue; }
    const current = sv.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;
    if (current !== target) setQty.push({ inventoryItemId: sv.inventoryItem.id, locationId, quantity: target, changeFromQuantity: current ?? null, label: `${fv.size}: ${current ?? '-'} -> ${target}` });
    if (item.price && sv.price !== item.price) priceUpdates.push({ id: sv.id, price: item.price, label: `${fv.size}: ${sv.price} -> ${item.price}` });
  }
  // rozmiary, których nie ma już w feedzie -> 0
  for (const sv of bySku.values()) {
    if (feedSkus.has(sv.sku)) continue;
    const current = sv.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;
    if (current && current !== 0) setQty.push({ inventoryItemId: sv.inventoryItem.id, locationId, quantity: 0, changeFromQuantity: current, label: `${sv.title}: ${current} -> 0 (brak w feedzie)` });
  }

  if (!setQty.length && !priceUpdates.length && !newVariants.length) return log(`  = bez zmian`);
  for (const c of setQty) log(`  ~ stan ${c.label}`);
  for (const c of priceUpdates) log(`  ~ cena ${c.label}`);
  for (const n of newVariants) log(`  + nowy rozmiar ${n.fv.size} (${n.target} szt.)`);
  if (DRY_RUN) return;

  if (setQty.length) {
    await gql(
      `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message } } }`,
      { input: { name: 'available', reason: 'correction',
        quantities: setQty.map(({ inventoryItemId, locationId: l, quantity, changeFromQuantity }) => ({ inventoryItemId, locationId: l, quantity, changeFromQuantity })) } },
    );
  }
  if (priceUpdates.length) {
    await gql(
      `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $pid, variants: $v) { userErrors { field message } } }`,
      { pid: productId, v: priceUpdates.map(({ id, price }) => ({ id, price })) },
    );
  }
  if (newVariants.length) {
    await gql(
      `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId: $pid, variants: $v) { userErrors { field message } } }`,
      { pid: productId, v: newVariants.map(({ fv, target }) => ({
        optionValues: [{ optionName: SIZE_OPTION, name: fv.size }],
        price: item.price || product.variants.nodes[0]?.price || '0.00',
        barcodes: fv.barcode ? [{ value: fv.barcode }] : undefined,
        inventoryPolicy: 'DENY',
        inventoryItem: { sku: fv.sku, tracked: true, requiresShipping: true },
        inventoryQuantities: [{ locationId, availableQuantity: target }],
      })) },
    );
  }
}

// ---------- main ----------
async function main() {
  const started = Date.now();
  const [rows, feed] = await Promise.all([readSheetRows(), readFeed()]);
  const items = sheetProducts(rows);
  log(`Arkusz: ${items.length} produktów LaBalancia. Feed: ${feed.size} produktów.${DRY_RUN ? ' (PRÓBA - bez zmian w sklepie)' : ''}`);

  const offline = DRY_RUN && !env.SHOPIFY_TOKEN && !env.SHOPIFY_CLIENT_ID;
  const locationId = offline ? null : await primaryLocation();
  let errors = 0;

  for (const item of items) {
    const f = feed.get(norm(item.source));
    log(`\n${item.title}  <-  "${item.source}"`);
    if (!f) { log('  ! nie ma go w feedzie XML (sprawdź "nazwa producenta" w arkuszu)'); errors++; continue; }
    if (!item.price) log('  ! brak poprawnej "Cena MAX" w arkuszu - ceny nie ruszam');
    log(`  feed: ${f.variants.map((v) => `${v.size}=${v.qty}`).join(', ')}`);
    if (offline) continue;
    try {
      const pid = await findProductBySkus(f.variants.map((v) => v.sku));
      if (pid) await updateProduct(item, f, pid, locationId);
      else await createProduct(item, f, locationId);
    } catch (e) {
      errors++;
      log(`  ! błąd: ${e.message}`);
    }
  }
  log(`\nGotowe w ${((Date.now() - started) / 1000).toFixed(1)} s, błędów: ${errors}.`);
  if (errors) process.exitCode = 1;
}

main().catch((e) => { console.error(`BŁĄD: ${e.message}`); process.exit(1); });
