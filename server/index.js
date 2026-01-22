import express from "express";
import cors from "cors";
import { Pool } from "pg";
import {
  Connection,
  PublicKey,
  SystemProgram,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { getCreateMetadataAccountV3InstructionDataSerializer } from "@metaplex-foundation/mpl-token-metadata";
import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";
// Token Metadata Program (fixed address)
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
import bs58 from "bs58";
import fs from "fs";
import path from "path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const box2PricesPath = path.join(__dirname, "..", "src", "box2Prices.json");
let BOX2_PRICES = {};
try {
  BOX2_PRICES = JSON.parse(fs.readFileSync(box2PricesPath, "utf8"));
} catch (err) {
  console.warn("Could not load box2Prices.json", err);
}

function normalizeName(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const app = express();
const corsOptions = {
  origin: (origin, callback) => {
    // Allow all Railway app frontends and localhost
    if (
      !origin ||
      origin.includes("railway.app") ||
      origin.startsWith("http://localhost:5173") ||
      origin.startsWith("http://127.0.0.1:5173") ||
      origin.startsWith("https://lootboxfrontend.vercel.app") ||
      origin.startsWith("https://gacha.watches")
      
    ) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.static("public"));

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ ok: false, error: "admin_secret_missing" });
  }
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  if (!token || token !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

const RPC_URL =
  process.env.SOLANA_RPC ||
  process.env.VITE_SOLANA_RPC ||
  clusterApiUrl("mainnet-beta");

const USDC_MINT_RAW =
  process.env.USDC_MINT ||
  // mainnet USDC
  "EPjFWdd5AufqSSqeM2qN3xqWg7iP5sQPhgSRXJ1nZgXn";
const USDC_MINT = new PublicKey(USDC_MINT_RAW);
const USDC_DECIMALS = Number(process.env.USDC_DECIMALS || 6);
const TEST_PRICE_USD = Number(process.env.TEST_PRICE_USD || 0);

const MERCHANT_RAW =
  process.env.MERCHANT_WALLET ||
  process.env.VITE_MERCHANT_WALLET ||
  "F4e1YgUmL1TiDf8FBkg3TYfLxzw3jCm1GkT8ZdJLkre9";

let MERCHANT_WALLET;
try {
  MERCHANT_WALLET = new PublicKey(MERCHANT_RAW);
} catch (e) {
  console.error("Invalid merchant wallet address. Fix MERCHANT_WALLET env.");
}
const HOT_WALLET_SECRET = process.env.HOT_WALLET_SECRET;
let HOT_WALLET_KEYPAIR = null;
if (HOT_WALLET_SECRET) {
  try {
    const secret = bs58.decode(HOT_WALLET_SECRET);
    HOT_WALLET_KEYPAIR = Keypair.fromSecretKey(secret);
    console.log("Hot wallet loaded");
  } catch (e) {
    console.error("Failed to load HOT_WALLET_SECRET", e);
  }
} else {
  console.warn("HOT_WALLET_SECRET not set; sellback payouts will fail.");
}

const connection = new Connection(RPC_URL, "confirmed");
const NFT_BASE_URL =
  process.env.NFT_IMAGE_BASE ||
  process.env.PUBLIC_BASE_URL ||
  process.env.VITE_API_BASE ||
  "https://lootbox-production-25a1.up.railway.app";
const HOT_WALLET_PUBKEY = HOT_WALLET_KEYPAIR?.publicKey;

async function fetchSolUsdPrice() {
  // Try Coingecko simple price; fallback to env SOL_USD_PRICE_FALLBACK
  const fallback = Number(process.env.SOL_USD_PRICE_FALLBACK || 0);
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { method: "GET", headers: { accept: "application/json" }, cache: "no-store" }
    );
    const data = await res.json();
    const price = Number(data?.solana?.usd);
    if (!isFinite(price) || price <= 0) throw new Error("bad_price");
    return price;
  } catch (err) {
    if (fallback > 0) return fallback;
    throw err;
  }
}

function toLamportsFromUsd(priceUsd, solUsd) {
  if (!solUsd || solUsd <= 0) throw new Error("invalid_sol_price");
  return Math.max(1, Math.round((priceUsd / solUsd) * LAMPORTS_PER_SOL));
}

function toUsdcMinorUnits(priceUsd) {
  return Math.max(1, Math.round(priceUsd * 10 ** USDC_DECIMALS));
}

async function getTxWithRetry(signature, attempts = 12, delayMs = 800) {
  for (let i = 0; i < attempts; i++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: null,
    });
    if (tx && tx.meta && !tx.meta.err) return tx;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

// DB setup (Postgres)
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Postgres is required.");
}

const pool =
  DATABASE_URL &&
  new Pool({
    connectionString: DATABASE_URL,
    ssl:
      process.env.PGSSLMODE === "disable"
        ? false
        : {
            rejectUnauthorized:
              process.env.PGSSL_REJECT_UNAUTHORIZED !== "false",
          },
  });

async function ensureSchema() {
  if (!pool) throw new Error("No Postgres pool available");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drops (
      id SERIAL PRIMARY KEY,
      wallet TEXT NOT NULL,
      boxId TEXT NOT NULL,
      boxName TEXT NOT NULL,
      rewardName TEXT NOT NULL,
      rewardValue DOUBLE PRECISION NOT NULL,
      signature TEXT NOT NULL,
      mint TEXT,
      createdAt TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      dropId INTEGER NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
      seller TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      fee DOUBLE PRECISION NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      createdAt TIMESTAMPTZ NOT NULL,
      soldAt TIMESTAMPTZ,
      buyer TEXT,
      sellerAmount DOUBLE PRECISION,
      feeAmount DOUBLE PRECISION
    );

    ALTER TABLE drops
    ADD COLUMN IF NOT EXISTS mint TEXT;

    ALTER TABLE drops
    ADD COLUMN IF NOT EXISTS mint_status TEXT DEFAULT 'minted';
    ALTER TABLE drops
    ADD COLUMN IF NOT EXISTS minted_at TIMESTAMPTZ;

    ALTER TABLE drops
    ADD COLUMN IF NOT EXISTS claim_status TEXT DEFAULT 'available';
    ALTER TABLE drops
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
    ALTER TABLE drops
    ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE tablename = 'drops' AND indexname = 'drops_signature_unique'
      ) THEN
        CREATE UNIQUE INDEX drops_signature_unique ON drops(signature);
      END IF;
    END$$;

    CREATE TABLE IF NOT EXISTS wallet_profiles (
      wallet TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      number TEXT,
      complement TEXT,
      district TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      country TEXT,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
}

async function upsertProfile(profile) {
  const {
    wallet,
    name,
    phone,
    email,
    address,
    number,
    complement,
    district,
    city,
    state,
    postal_code,
    country,
  } = profile;
  if (!pool) throw new Error("No Postgres pool available");
  await pool.query(
    `
    INSERT INTO wallet_profiles
      (wallet, name, phone, email, address, number, complement, district, city, state, postal_code, country, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
    ON CONFLICT (wallet) DO UPDATE SET
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      address = EXCLUDED.address,
      number = EXCLUDED.number,
      complement = EXCLUDED.complement,
      district = EXCLUDED.district,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      postal_code = EXCLUDED.postal_code,
      country = EXCLUDED.country,
      updated_at = NOW();
  `,
    [
      wallet,
      name || null,
      phone || null,
      email || null,
      address || null,
      number || null,
      complement || null,
      district || null,
      city || null,
      state || null,
      postal_code || null,
      country || null,
    ]
  );
}

async function getProfile(wallet) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `SELECT wallet, name, phone, email, address, number, complement, district, city, state, postal_code AS "postalCode", country, updated_at AS "updatedAt" FROM wallet_profiles WHERE wallet = $1`,
    [wallet]
  );
  return rows[0] || null;
}

async function markDropClaimed(dropId) {
  if (!pool) throw new Error("No Postgres pool available");
  await pool.query(
    `UPDATE drops SET claim_status = 'claimed', claimed_at = NOW() WHERE id = $1`,
    [dropId]
  );
}

async function markDropSent(dropId) {
  if (!pool) throw new Error("No Postgres pool available");
  await pool.query(
    `UPDATE drops SET claim_status = 'sent', sent_at = NOW() WHERE id = $1`,
    [dropId]
  );
}

async function insertDrop(row) {
  if (!pool) throw new Error("No Postgres pool available");
  const {
    wallet,
    boxId,
    boxName,
    rewardName,
    rewardValue,
    signature,
    mint = null,
    createdAt,
    mintStatus = "pending",
  } = row;
  const result = await pool.query(
    `
      INSERT INTO drops (wallet, boxId, boxName, rewardName, rewardValue, signature, mint, createdAt, claim_status, mint_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'available', $9)
      ON CONFLICT (signature) DO NOTHING
      RETURNING id
    `,
    [
      wallet,
      boxId,
      boxName,
      rewardName,
      rewardValue,
      signature,
      mint,
      createdAt,
      mintStatus,
    ]
  );
  return result.rows?.[0]?.id;
}

async function selectDropBySignature(signature) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      SELECT
        id,
        wallet,
        boxid AS "boxId",
        boxname AS "boxName",
        rewardname AS "rewardName",
        rewardvalue AS "rewardValue",
        mint,
        signature,
        createdat AS "createdAt",
        claim_status AS "claimStatus",
        claimed_at AS "claimedAt",
        sent_at AS "sentAt",
        mint_status AS "mintStatus",
        minted_at AS "mintedAt"
      FROM drops
      WHERE signature = $1
      LIMIT 1
    `,
    [signature]
  );
  return rows[0] || null;
}

async function selectDropById(id) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      SELECT
        id,
        wallet,
        boxid AS "boxId",
        boxname AS "boxName",
        rewardname AS "rewardName",
        rewardvalue AS "rewardValue",
        mint,
        signature,
        createdat AS "createdAt",
        claim_status AS "claimStatus",
        claimed_at AS "claimedAt",
        sent_at AS "sentAt",
        mint_status AS "mintStatus",
        minted_at AS "mintedAt"
      FROM drops
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );
  return rows[0] || null;
}

async function updateDropMintStatus(dropId, { status, mint = null }) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      UPDATE drops
      SET mint_status = $2,
          mint = COALESCE($3, mint),
          minted_at = CASE WHEN $3 IS NOT NULL AND $2 = 'minted' THEN NOW() ELSE minted_at END
      WHERE id = $1
      RETURNING
        id,
        wallet,
        boxid AS "boxId",
        boxname AS "boxName",
        rewardname AS "rewardName",
        rewardvalue AS "rewardValue",
        mint,
        signature,
        createdat AS "createdAt",
        claim_status AS "claimStatus",
        claimed_at AS "claimedAt",
        sent_at AS "sentAt",
        mint_status AS "mintStatus",
        minted_at AS "mintedAt"
    `,
    [dropId, status, mint]
  );
  return rows[0] || null;
}

async function lockDropForMint(dropId) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      UPDATE drops
      SET mint_status = 'minting'
      WHERE id = $1 AND mint_status IN ('pending', 'failed')
      RETURNING id
    `,
    [dropId]
  );
  return rows[0] || null;
}

async function selectDropsByWallet(wallet) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      SELECT
        id,
        boxid AS "boxId",
        boxname AS "boxName",
        rewardname AS "rewardName",
        rewardvalue AS "rewardValue",
        mint,
        signature,
        createdat AS "createdAt",
        claim_status AS "claimStatus",
        claimed_at AS "claimedAt",
        sent_at AS "sentAt",
        mint_status AS "mintStatus",
        minted_at AS "mintedAt"
      FROM drops
      WHERE wallet = $1
      ORDER BY createdat DESC
    `,
    [wallet]
  );
  return rows;
}

async function createListing({ dropId, seller, price, fee }) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      INSERT INTO listings (dropId, seller, price, fee, active, createdAt)
      VALUES ($1, $2, $3, $4, TRUE, NOW())
      RETURNING *
    `,
    [dropId, seller, price, fee]
  );
  return rows[0];
}

async function listActiveListings() {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      SELECT
        l.id,
        l.dropId,
        l.seller,
        l.price,
        l.fee,
        l.createdAt,
        d.boxId AS "boxId",
        d.boxName AS "boxName",
        d.rewardName AS "rewardName",
        d.rewardValue AS "rewardValue",
        d.mint AS "mint",
        d.signature AS "signature",
        d.id as "dropId",
        d.mint_status AS "mintStatus",
        d.minted_at AS "mintedAt"
      FROM listings l
      JOIN drops d ON d.id = l.dropId
      WHERE l.active = TRUE
      ORDER BY l.createdAt DESC
    `
  );
  return rows;
}

async function getListingById(id) {
  if (!pool) throw new Error("No Postgres pool available");
  const { rows } = await pool.query(
    `
      SELECT
        l.*,
        d.boxId AS "boxId",
        d.boxName AS "boxName",
        d.rewardName AS "rewardName",
        d.rewardValue AS "rewardValue",
        d.mint AS "mint",
        d.signature AS "signature",
        d.id as "dropId",
        d.mint_status AS "mintStatus",
        d.minted_at AS "mintedAt"
      FROM listings l
      JOIN drops d ON d.id = l.dropId
      WHERE l.id = $1
    `,
    [id]
  );
  return rows[0];
}

async function deactivateListing(id, buyer, sellerAmount, feeAmount) {
  if (!pool) throw new Error("No Postgres pool available");
  await pool.query(
    `
      UPDATE listings
      SET active = FALSE,
          soldAt = NOW(),
          buyer = $2,
          sellerAmount = $3,
          feeAmount = $4
      WHERE id = $1
    `,
    [id, buyer, sellerAmount, feeAmount]
  );
}

async function transferDropOwnership(dropId, newOwner) {
  if (!pool) throw new Error("No Postgres pool available");
  const res = await pool.query(
    `
      UPDATE drops
      SET wallet = $2
      WHERE id = $1
      RETURNING *
    `,
    [dropId, newOwner]
  );
  return res.rows[0];
}

ensureSchema()
  .then(() => console.log("Postgres schema ready"))
  .catch((err) => {
    console.error("Failed to ensure schema in Postgres", err);
  });

const BASE_LOOTBOXES = [
  { id: "common", name: "Entry level box", priceUsd: 50 },
  { id: "rare", name: "Swiss box", priceUsd: 250 },
];

const LOOTBOXES = BASE_LOOTBOXES.map((b) => ({
  ...b,
  priceUsd: TEST_PRICE_USD > 0 ? TEST_PRICE_USD : b.priceUsd,
}));

function buildRange(prefix, count, chance, baseValue) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${i + 1}`,
    value: baseValue + i * 0.001,
    chance,
  }));
}

function loadAssetNames(relativeDir) {
  try {
    const basePath = path.join(__dirname, "..", "src", "assets", relativeDir);
    const files = fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.parse(d.name).name)
      .sort((a, b) => a.localeCompare(b));
    return files;
  } catch {
    return [];
  }
}

const BOX2_UNCOMMON_NAMES = loadAssetNames(path.join("box2", "uncommon"));
const BOX2_RARE_NAMES = loadAssetNames(path.join("box2", "rares"));
const BOX2_EPIC_NAMES = loadAssetNames(path.join("box2", "epics"));
const BOX2_LEGENDARY_NAMES = loadAssetNames(path.join("box2", "legendaries"));
const BOX2_PRICE_MAP = Object.entries(BOX2_PRICES).reduce((acc, [key, value]) => {
  acc[normalizeName(key)] = value;
  return acc;
}, {});

function findBox(id) {
  return LOOTBOXES.find((b) => b.id === id);
}

function buildUniformRewards(names, totalChance) {
  const perItem = names.length ? totalChance / names.length : 0;
  return names.map((name, idx) => ({
    name,
    value: BOX2_PRICE_MAP[normalizeName(name)] || 0.001,
    chance: perItem,
  }));
}

function applyTestRewardValue(reward) {
  if (TEST_PRICE_USD > 0) return { ...reward, value: TEST_PRICE_USD };
  return reward;
}

function pickPercentageReward(box) {
  const rewardsMap = {
    common: [
      { name: "CASIO A168WEM-7", value: 35, chance: 14.1667 },
      { name: "CASIO FT-500WC-1BV", value: 37.5, chance: 14.1667 },
      { name: "CASIO  LWS-1200H-1A2V", value: 37.5, chance: 14.1667 },
      { name: "CASIO W-217H-5AV", value: 30, chance: 14.1667 },
      { name: "CASIO W-218H-3BV", value: 30, chance: 14.1667 },
      { name: "G-SHOCK GD-100GB-1", value: 70, chance: 14.1667 },
      { name: "CASIO AQ-S820W-5AV", value: 45, chance: 1.25 },
      { name: "CASIO B640WB-1B", value: 30, chance: 1.25 },
      { name: "CASIO LA680WGA-9", value: 30, chance: 1.25 },
      { name: "CASIO MDV-106B-1A2V", value: 90, chance: 1.25 },
      { name: "Easy Reader Day Date 35mm Expansion Band Watch", value: 55, chance: 1.25 },
      { name: "Monopoly x Timex MK1 36mm Fabric Strap", value: 52.5, chance: 1.25 },
      { name: "Timex x Peanuts Snoopy 38mm Fabric Strap", value: 52.5, chance: 1.25 },
      { name: "Weekender 38mm Fabric Strap", value: 45, chance: 1.25 },
      { name: "Citizen Garrison Eco-Drive 43mm - Black on Bracelet", value: 200, chance: 0.49 },
      { name: "Orient Bambino 38mm - White on Leather Strap", value: 140, chance: 0.49 },
      { name: "Seiko SNKN37 Recraft Series 43.5mm - Blue on Leather Strap", value: 160, chance: 0.49 },
      { name: "Timex IRONMAN Classic 30-Lap 38mm Recycled Fabric Strap", value: 47.5, chance: 0.49 },
      { name: "Timex Legacy Ocean x Peanuts Recycled Material 42mm - Blue on Bracelet", value: 65, chance: 0.49 },
      { name: "Timex Q Timex Gold-Tone 36mm - Blue on Bracelet", value: 185, chance: 0.49 },
      { name: "Timex Q Timex Gold-Tone 36mm - Green on Bracelet", value: 185, chance: 0.49 },
      { name: "Timex x Fortnite Acadia 40mm Fabric Strap", value: 75, chance: 0.49 },
      { name: "Timex x Fortnite T80 36mm Stainless Steel Bracelet", value: 75, chance: 0.49 },
      { name: "Waste More Time Watch Timex Legacy Ocean 42mm with Recycled Plastic Bracelet", value: 55, chance: 0.49 },
      { name: "Bulova Hack Watch 38mm - Black on Leather Strap", value: 275, chance: 0.0077 },
      { name: "Citizen Zenshin Chrono Super Titanium 42.4mm - Blue on Bracelet", value: 325, chance: 0.0077 },
      { name: "Frederique Constant Classics Index Automatic Steel 39mm - Green on Bracelet", value: 1450, chance: 0.0077 },
      { name: "Hamilton Jazzmaster Open Heart Auto 40mm - Blue on Bracelet", value: 950, chance: 0.0077 },
      { name: "Hamilton Khaki Field Mechanical Brown PVD 38mm - Blrown on One-Piece Textile Strap", value: 650, chance: 0.0077 },
      { name: "Longines HydroConquest 41mm - Green on Bracelet", value: 1150, chance: 0.0077 },
      { name: "Longines Mini DolceVita 29mm - Silver FliniquǸ on Leather Strap", value: 1500, chance: 0.0077 },
      { name: "Muhle Glashutte 29er 36.6mm - White on Bracelet", value: 1750, chance: 0.0077 },
      { name: "Omega Speedmaster Day Date", value: 1800, chance: 0.0077 },
      { name: "Sternglas Hamburg Mecha-Quartz Chrono 42mm - Green on Leather Strap", value: 375, chance: 0.0077 },
      { name: "Sternglas Lumatik Automatic 38mm - Blue on Nylon Strap", value: 375, chance: 0.0077 },
      { name: "Tissot PRX Powermatic 80 35mm - Gold-Tone on Bracelet", value: 400, chance: 0.0077 },
      { name: "Tissot PRX Quartz 40mm - Silver on Bracelet", value: 262.5, chance: 0.0077 },
    ],
    rare: [
      ...buildUniformRewards(BOX2_UNCOMMON_NAMES, 85),
      ...buildUniformRewards(BOX2_RARE_NAMES, 10),
      ...buildUniformRewards(BOX2_EPIC_NAMES, 4.9),
      ...buildUniformRewards(BOX2_LEGENDARY_NAMES, 0.1),
    ],
  };
  const rewards = rewardsMap[box.id];
  if (!rewards) return null;

  const random = Math.random() * 100;
  let sum = 0;
  for (const reward of rewards) {
    sum += reward.chance;
    if (random <= sum) {
      return applyTestRewardValue(reward);
    }
  }
  const fallback = rewards[rewards.length - 1];
  return applyTestRewardValue(fallback);
}

function buildAccountKeyList(message, loadedAddresses) {
  // Returns a flat array of PublicKeys (or strings) from legacy or v0 messages
  try {
    if (message.getAccountKeys) {
      const keysObj = message.getAccountKeys({
        accountKeysFromLookups: loadedAddresses,
      });
      const list = [];
      if (Array.isArray(keysObj)) list.push(...keysObj);
      if (Array.isArray(keysObj.staticAccountKeys))
        list.push(...keysObj.staticAccountKeys);
      const lookups = loadedAddresses || keysObj.loadedAddresses || {};
      if (Array.isArray(lookups.writable)) list.push(...lookups.writable);
      if (Array.isArray(lookups.readonly)) list.push(...lookups.readonly);
      return list;
    }
    return Array.isArray(message.accountKeys) ? message.accountKeys : [];
  } catch (e) {
    return Array.isArray(message.accountKeys) ? message.accountKeys : [];
  }
}

function getBalanceDelta(tx, address) {
  if (!tx || !tx.meta || !tx.transaction) return 0;
  const keys = buildAccountKeyList(
    tx.transaction.message,
    tx.meta?.loadedAddresses
  );
  const idx = keys.findIndex((k) => {
    const v = k && k.toBase58 && typeof k.toBase58 === "function" ? k.toBase58() : k;
    return v === address;
  });
  if (idx === -1) return 0;
  const pre = tx.meta.preBalances[idx] || 0;
  const post = tx.meta.postBalances[idx] || 0;
  return post - pre;
}

function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str || "", "utf8");
  if (buf.length <= maxBytes) return str || "";
  return buf.slice(0, maxBytes).toString("utf8");
}

async function mintRewardNft(rewardName, ownerPubkeyStr) {
  if (!HOT_WALLET_KEYPAIR) return null;
  let mintAddress = null;
  try {
    const ownerPk = new PublicKey(ownerPubkeyStr);
    const mx = Metaplex.make(connection).use(keypairIdentity(HOT_WALLET_KEYPAIR));
    const safeName = truncateUtf8(`Lootbox ${rewardName}`, 32);
    const rawUri = `${NFT_BASE_URL}/api/nft/metadata/${encodeURIComponent(
      rewardName
    )}`;
    const safeUri = truncateUtf8(rawUri, 200);

    const builder = await mx.nfts().builders().create({
      uri: safeUri,
      name: safeName,
      symbol: "WATCH",
      sellerFeeBasisPoints: 0,
      tokenOwner: ownerPk,
      updateAuthority: HOT_WALLET_KEYPAIR,
      mintAuthority: HOT_WALLET_KEYPAIR,
      payer: HOT_WALLET_KEYPAIR,
      isMutable: true,
      freezeAuthority: HOT_WALLET_KEYPAIR.publicKey,
      mintTokens: true,
    });

    await builder.sendAndConfirm(mx, { commitment: "finalized" });
    const ctx = builder.getContext ? builder.getContext() : {};
    const mintPk = ctx?.mintAddress;
    mintAddress = mintPk?.toBase58
      ? mintPk.toBase58()
      : mintPk
      ? String(mintPk)
      : null;

    // Ensure the owner ATA holds the NFT (guards against partial mint)
    if (mintPk && ownerPk) {
      const ata = await getAssociatedTokenAddress(mintPk, ownerPk);
      for (let i = 0; i < 3; i++) {
        try {
          const acc = await getAccount(connection, ata);
          if (Number(acc.amount) >= 1) break;
        } catch (err) {
          // ignore and retry
        }
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }

    return mintAddress;
  } catch (e) {
    console.error("mintRewardNft error", e);
    return mintAddress;
  }
}

async function moveNftWithDelegate({ mint, owner, destination }) {
  if (!HOT_WALLET_KEYPAIR) {
    throw new Error("hot_wallet_missing");
  }
  async function retryAta(fn, tries = 4, baseDelay = 400) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        const name = e?.name || "";
        if (
          name === "TokenAccountNotFoundError" ||
          name === "AccountNotFoundError"
        ) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, baseDelay * (i + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  const mintPk = new PublicKey(mint);
  const ownerPk = new PublicKey(owner);
  const destPk = new PublicKey(destination);

  let sourceAtaAcc = null;
  for (let i = 0; i < 4; i++) {
    sourceAtaAcc = await retryAta(() =>
      getOrCreateAssociatedTokenAccount(
        connection,
        HOT_WALLET_KEYPAIR,
        mintPk,
        ownerPk
      )
    );
    if (Number(sourceAtaAcc.amount) >= 1) break;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (!sourceAtaAcc || Number(sourceAtaAcc.amount) < 1) {
    throw new Error("insufficient_nft_balance");
  }

  // Validate delegate approval for the hot wallet on the user's ATA
  const sourceAcc = await getAccount(connection, sourceAtaAcc.address);
  const delegateMatches =
    sourceAcc.delegate &&
    sourceAcc.delegate.toBase58 &&
    sourceAcc.delegate.toBase58() === HOT_WALLET_KEYPAIR.publicKey.toBase58();
  const hasAllowance =
    sourceAcc.delegatedAmount && Number(sourceAcc.delegatedAmount) >= 1;
  if (!delegateMatches || !hasAllowance) {
    throw new Error("delegate_missing");
  }

  const destAta = await retryAta(() =>
    getOrCreateAssociatedTokenAccount(
      connection,
      HOT_WALLET_KEYPAIR,
      mintPk,
      destPk
    )
  );

  const ix = createTransferCheckedInstruction(
    sourceAtaAcc.address,
    mintPk,
    destAta.address,
    HOT_WALLET_KEYPAIR.publicKey,
    1,
    0
  );

  const tx = new Transaction().add(ix);
  await sendAndConfirmTransaction(connection, tx, [HOT_WALLET_KEYPAIR]);

  return { sourceAta: sourceAtaAcc.address.toBase58(), destAta: destAta.address.toBase58() };
}

async function buildClaimTransaction({ mint, owner, destination }) {
  const mintPk = new PublicKey(mint);
  const ownerPk = new PublicKey(owner);
  const destPk = new PublicKey(destination);

  const ownerAta = await getAssociatedTokenAddress(mintPk, ownerPk);
  // Ensure the owner's ATA exists and holds the NFT
  try {
    const sourceAcc = await getAccount(connection, ownerAta);
    if (Number(sourceAcc.amount) < 1) {
      throw new Error("owner_ata_empty");
    }
  } catch (err) {
    if (err?.message === "owner_ata_empty") throw err;
    throw new Error("owner_ata_missing");
  }

  const merchantAta = await getAssociatedTokenAddress(mintPk, destPk);
  const tx = new Transaction();
  const destInfo = await connection.getAccountInfo(merchantAta);
  if (!destInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(ownerPk, merchantAta, destPk, mintPk)
    );
  }

  tx.add(
    createTransferCheckedInstruction(
      ownerAta,
      mintPk,
      merchantAta,
      ownerPk,
      1,
      0
    )
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPk;

  return { tx, blockhash, lastValidBlockHeight, ownerAta, merchantAta };
}

app.get("/health", (req, res) => {
  if (!MERCHANT_WALLET) {
    return res.status(500).json({ ok: false, error: "merchant_wallet_invalid" });
  }
  return res.json({ ok: true });
});

app.get("/api/nft/metadata/:reward", (req, res) => {
  const { reward } = req.params;
  const image = `${NFT_BASE_URL}/nft/${reward}.png`;
  return res.json({
    name: `Lootbox ${reward}`,
    symbol: "WATCH",
    description: `Item ${reward} from Lootboxes`,
    image,
    attributes: [{ trait_type: "Reward", value: reward }],
  });
});

app.get("/api/inventory/:wallet", (req, res) => {
  const { wallet } = req.params;
  if (!wallet) {
    return res.status(400).json({ ok: false, error: "missing_wallet" });
  }
  if (!pool) {
    return res.status(500).json({ ok: false, error: "db_not_configured" });
  }
  let pubkey;
  try {
    pubkey = new PublicKey(wallet);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "invalid_wallet" });
  }
  selectDropsByWallet(pubkey.toBase58())
    .then((drops) => res.json({ ok: true, drops }))
    .catch((err) => {
      console.error("inventory error", err);
      res.status(500).json({ ok: false, error: "inventory_error" });
    });
});

app.get("/api/config", (req, res) => {
  return res.json({
    ok: true,
    delegateWallet: HOT_WALLET_PUBKEY?.toBase58() || MERCHANT_WALLET?.toBase58(),
  });
});

app.get("/api/shop", async (req, res) => {
  try {
    const listings = await listActiveListings();
    return res.json({ ok: true, listings });
  } catch (err) {
    console.error("shop list error", err);
    return res.status(500).json({ ok: false, error: "shop_list_error" });
  }
});

app.post("/api/shop/list", async (req, res) => {
  try {
    const { dropId, price, mint } = req.body || {};
    if (!dropId || !price || Number(price) <= 0 || !mint) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }
    if (!pool) {
      return res.status(500).json({ ok: false, error: "db_not_configured" });
    }
    const { rows } = await pool.query("SELECT * FROM drops WHERE id = $1", [
      dropId,
    ]);
    const drop = rows[0];
    if (!drop) {
      return res.status(404).json({ ok: false, error: "drop_not_found" });
    }
    // prevent duplicate active listing for same drop
    const active = await pool.query(
      "SELECT id FROM listings WHERE dropId = $1 AND active = TRUE",
      [dropId]
    );
    if (active.rows.length > 0) {
      return res.status(400).json({ ok: false, error: "already_listed" });
    }

    if (drop.mint && drop.mint !== mint) {
      return res.status(400).json({ ok: false, error: "mint_mismatch" });
    }
    const seller = drop.wallet;
    // require minted
    if (!drop.mint && !mint) {
      return res.status(400).json({ ok: false, error: "mint_missing" });
    }
    // ensure drop row has mint saved
    if (!drop.mint && mint) {
      await pool.query("UPDATE drops SET mint = $1 WHERE id = $2", [mint, dropId]);
    }
    const fee = Number(price) * 0.1;
    const listing = await createListing({
      dropId,
      seller,
      price: Number(price),
      fee,
    });
    return res.json({ ok: true, listing });
  } catch (err) {
    console.error("shop list create error", err);
    return res.status(500).json({ ok: false, error: "shop_list_error" });
  }
});

app.post("/api/shop/buy", async (req, res) => {
  try {
    const { listingId, signature } = req.body || {};
    if (!listingId || !signature) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }
    if (!pool) {
      return res.status(500).json({ ok: false, error: "db_not_configured" });
    }
    const listing = await getListingById(listingId);
    if (!listing || !listing.active) {
      return res.status(400).json({ ok: false, error: "listing_inactive" });
    }
    const dropRow = await pool.query("SELECT * FROM drops WHERE id = $1", [
      listing.dropId,
    ]);
    const drop = dropRow.rows[0];
    if (!drop) {
      return res.status(400).json({ ok: false, error: "drop_not_found" });
    }
    if (!drop.mint) {
      return res.status(400).json({ ok: false, error: "mint_missing" });
    }

    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err) {
      console.error("shop buy tx_not_confirmed", tx?.meta?.err);
      return res.status(400).json({ ok: false, error: "tx_not_confirmed" });
    }

    const priceLamports = Math.round(listing.price * 1_000_000_000);
    const feeLamports = Math.round(listing.fee * 1_000_000_000);
    const sellerLamports = priceLamports - feeLamports;

    const sellerDelta = getBalanceDelta(tx, listing.seller);
    const feeDelta = getBalanceDelta(tx, MERCHANT_WALLET.toBase58());

    if (sellerDelta + feeDelta < priceLamports) {
      console.error("shop buy payment_mismatch", {
        sellerDelta,
        feeDelta,
        priceLamports,
        listingId,
        signature,
      });
      return res.status(400).json({ ok: false, error: "payment_mismatch" });
    }

    const keysFlat = buildAccountKeyList(
      tx.transaction.message,
      tx.meta?.loadedAddresses
    );
    const buyerPubkeyCandidate =
      tx.transaction.message.getAccountKeys &&
      tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses,
      })?.payer
        ? tx.transaction.message
            .getAccountKeys({
              accountKeysFromLookups: tx.meta?.loadedAddresses,
            })
            .payer
        : keysFlat[0];
    const buyerPubkey =
      buyerPubkeyCandidate && buyerPubkeyCandidate.toBase58
        ? buyerPubkeyCandidate.toBase58()
        : buyerPubkeyCandidate;

    if (!buyerPubkey) {
      console.error("shop buy buyer_not_found_in_tx", {
        listingId,
        signature,
      });
      return res
        .status(500)
        .json({ ok: false, error: "buyer_not_found_in_tx" });
    }

    const updatedDrop = await transferDropOwnership(listing.dropId, buyerPubkey);
    // move NFT on-chain using delegate approval
    try {
      await moveNftWithDelegate({
        mint: drop.mint,
        owner: listing.seller,
        destination: buyerPubkey,
      });
    } catch (err) {
      console.error("nft transfer failed", err);
      return res.status(400).json({ ok: false, error: "nft_transfer_failed" });
    }
    await deactivateListing(
      listing.id,
      buyerPubkey,
      sellerLamports / LAMPORTS_PER_SOL,
      feeLamports / LAMPORTS_PER_SOL
    );

  return res.json({
    ok: true,
    listingId: listing.id,
    buyer: buyerPubkey,
    drop: {
        id: updatedDrop?.id || listing.dropId,
        boxId: updatedDrop?.boxid || listing.boxId,
        boxName: updatedDrop?.boxname || listing.boxName,
        rewardName: updatedDrop?.rewardname || listing.rewardName,
        rewardValue: updatedDrop?.rewardvalue || listing.rewardValue,
        mint: updatedDrop?.mint || listing.mint,
        signature: updatedDrop?.signature || listing.signature,
      },
    });
  } catch (err) {
    console.error("shop buy error", err);
    return res.status(500).json({ ok: false, error: err?.message || "internal_error" });
  }
});

app.post("/api/sellback", async (req, res) => {
  try {
    const { dropId, wallet } = req.body || {};
    if (!dropId || !wallet) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }
    if (!HOT_WALLET_KEYPAIR) {
      return res.status(500).json({ ok: false, error: "hot_wallet_missing" });
    }
    const dropRow = await pool.query("SELECT * FROM drops WHERE id = $1", [
      dropId,
    ]);
    const drop = dropRow.rows[0];
    if (!drop) {
      return res.status(404).json({ ok: false, error: "drop_not_found" });
    }
    if (drop.wallet !== wallet) {
      return res.status(403).json({ ok: false, error: "not_owner" });
    }
    if (!drop.mint) {
      return res.status(400).json({ ok: false, error: "mint_missing" });
    }
    const payoutUsdc = Math.round(
      Number(drop.rewardvalue || 0) * 0.85 * 10 ** USDC_DECIMALS
    );
    if (payoutUsdc <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_value" });
    }

    // move NFT to house first (delegate approval required)
    try {
      await moveNftWithDelegate({
        mint: drop.mint,
        owner: wallet,
        destination: MERCHANT_WALLET.toBase58(),
      });
    } catch (err) {
      console.error("sellback nft transfer failed", err);
      return res.status(400).json({ ok: false, error: "nft_transfer_failed" });
    }

    const userPk = new PublicKey(wallet);
    const userAta = await getAssociatedTokenAddress(USDC_MINT, userPk);
    const hotAta = await getAssociatedTokenAddress(
      USDC_MINT,
      HOT_WALLET_KEYPAIR.publicKey
    );
    const tx = new Transaction();
    const userAtaInfo = await connection.getAccountInfo(userAta);
    if (!userAtaInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          HOT_WALLET_KEYPAIR.publicKey,
          userAta,
          userPk,
          USDC_MINT
        )
      );
    }
    const hotAtaInfo = await connection.getAccountInfo(hotAta);
    if (!hotAtaInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          HOT_WALLET_KEYPAIR.publicKey,
          hotAta,
          HOT_WALLET_KEYPAIR.publicKey,
          USDC_MINT
        )
      );
    }
    tx.add(
      createTransferCheckedInstruction(
        hotAta,
        USDC_MINT,
        userAta,
        HOT_WALLET_KEYPAIR.publicKey,
        payoutUsdc,
        USDC_DECIMALS
      )
    );
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = HOT_WALLET_KEYPAIR.publicKey;
    tx.sign(HOT_WALLET_KEYPAIR);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    await transferDropOwnership(dropId, MERCHANT_WALLET.toBase58());

    return res.json({ ok: true, signature: sig });
  } catch (err) {
    console.error("sellback error", err);
    return res.status(500).json({ ok: false, error: err?.message || "internal_error" });
  }
});

function pickTokenBalance(balances, ownerStr, mintStr) {
  return balances?.find(
    (b) => b.owner === ownerStr && b.mint === mintStr
  );
}

function bigAmount(balance) {
  return BigInt(balance?.uiTokenAmount?.amount || "0");
}

app.post("/api/claim-tx", async (req, res) => {
  try {
    const { dropId, wallet } = req.body || {};
    if (!dropId || !wallet) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }
    const dropRow = await pool.query("SELECT * FROM drops WHERE id = $1", [
      dropId,
    ]);
    const drop = dropRow.rows[0];
    if (!drop) {
      return res.status(404).json({ ok: false, error: "drop_not_found" });
    }
    if (drop.wallet !== wallet) {
      return res.status(403).json({ ok: false, error: "not_owner" });
    }
    if (!drop.mint) {
      return res.status(400).json({ ok: false, error: "mint_missing" });
    }
    if (drop.claim_status === "claimed" || drop.claim_status === "sent") {
      return res.status(400).json({ ok: false, error: "already_claimed" });
    }

    try {
      const { tx, blockhash, lastValidBlockHeight, ownerAta, merchantAta } =
        await buildClaimTransaction({
          mint: drop.mint,
          owner: wallet,
          destination: MERCHANT_WALLET.toBase58(),
        });
      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      return res.json({
        ok: true,
        tx: serialized.toString("base64"),
        blockhash,
        lastValidBlockHeight,
        ownerAta: ownerAta.toBase58(),
        merchantAta: merchantAta.toBase58(),
      });
    } catch (err) {
      console.error("claim build tx failed", err);
      return res.status(400).json({
        ok: false,
        error: err?.message || "claim_build_failed",
      });
    }
  } catch (err) {
    console.error("claim-tx error", err);
    return res.status(500).json({ ok: false, error: err?.message || "internal_error" });
  }
});

app.post("/api/claim-confirm", async (req, res) => {
  try {
    const { dropId, wallet, signature } = req.body || {};
    if (!dropId || !wallet || !signature) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }
    const dropRow = await pool.query("SELECT * FROM drops WHERE id = $1", [
      dropId,
    ]);
    const drop = dropRow.rows[0];
    if (!drop) {
      return res.status(404).json({ ok: false, error: "drop_not_found" });
    }
    if (drop.wallet !== wallet) {
      return res.status(403).json({ ok: false, error: "not_owner" });
    }
    if (!drop.mint) {
      return res.status(400).json({ ok: false, error: "mint_missing" });
    }
    if (drop.claim_status === "claimed" || drop.claim_status === "sent") {
      return res.status(400).json({ ok: false, error: "already_claimed" });
    }

    const walletPk = new PublicKey(wallet);
    const mintPk = new PublicKey(drop.mint);
    const merchantPk = MERCHANT_WALLET;

    const parsedTx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!parsedTx) {
      return res
        .status(404)
        .json({ ok: false, error: "tx_not_found_or_not_finalized" });
    }
    if (parsedTx.meta?.err) {
      return res.status(400).json({ ok: false, error: "tx_failed", detail: parsedTx.meta.err });
    }

    const accountKeys = parsedTx.transaction.message.accountKeys || [];
    const signerKeys = accountKeys
      .filter((k) => k.signer)
      .map((k) =>
        typeof k.pubkey === "string"
          ? k.pubkey
          : k.pubkey?.toBase58
          ? k.pubkey.toBase58()
          : k.pubkey
      )
      .filter(Boolean);
    if (!signerKeys.includes(walletPk.toBase58())) {
      return res.status(403).json({ ok: false, error: "wallet_not_signer" });
    }

    const ownerStr = walletPk.toBase58();
    const merchantStr = merchantPk.toBase58();
    const mintStr = mintPk.toBase58();

    const preOwner = pickTokenBalance(parsedTx.meta?.preTokenBalances, ownerStr, mintStr);
    const postOwner = pickTokenBalance(parsedTx.meta?.postTokenBalances, ownerStr, mintStr);
    const preMerchant = pickTokenBalance(parsedTx.meta?.preTokenBalances, merchantStr, mintStr);
    const postMerchant = pickTokenBalance(parsedTx.meta?.postTokenBalances, merchantStr, mintStr);

    const preOwnerAmt = bigAmount(preOwner);
    const postOwnerAmt = bigAmount(postOwner);
    const preMerchantAmt = bigAmount(preMerchant);
    const postMerchantAmt = bigAmount(postMerchant);

    const ownerDelta = preOwnerAmt - postOwnerAmt;
    const merchantDelta = postMerchantAmt - preMerchantAmt;

    if (ownerDelta < 1n || merchantDelta < 1n) {
      return res.status(400).json({
        ok: false,
        error: "transfer_not_detected",
        detail: {
          ownerDelta: ownerDelta.toString(),
          merchantDelta: merchantDelta.toString(),
        },
      });
    }

    try {
      await markDropClaimed(dropId);
    } catch (err) {
      console.error("mark claimed failed", err);
      return res.status(500).json({ ok: false, error: "claim_mark_failed" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("claim-confirm error", err);
    return res.status(500).json({ ok: false, error: err?.message || "internal_error" });
  }
});

// Legacy endpoint: kept only to avoid breaking older clients
app.post("/api/claim", (req, res) => {
  return res.status(400).json({
    ok: false,
    error: "claim_flow_updated",
    detail: "Use /api/claim-tx to build and /api/claim-confirm to finalize.",
  });
});

app.get("/api/admin/inventories", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows } = await pool.query(
      `
      SELECT
        d.wallet,
        wp.name,
        wp.phone,
        wp.email,
        wp.address,
        wp.number,
        wp.complement,
        wp.district,
        wp.city,
        wp.state,
        wp.postal_code AS "postalCode",
        wp.country,
        wp.updated_at AS "profileUpdatedAt",
        json_agg(
          json_build_object(
            'id', d.id,
            'boxId', d.boxid,
            'boxName', d.boxname,
            'rewardName', d.rewardname,
            'rewardValue', d.rewardvalue,
            'mint', d.mint,
            'signature', d.signature,
            'createdAt', d.createdat,
            'claimStatus', d.claim_status,
            'claimedAt', d.claimed_at,
            'sentAt', d.sent_at,
            'mintStatus', d.mint_status,
            'mintedAt', d.minted_at
          ) ORDER BY d.createdat DESC
        ) AS drops
      FROM drops d
      LEFT JOIN wallet_profiles wp ON wp.wallet = d.wallet
      WHERE d.claim_status IN ('claimed', 'sent')
      GROUP BY d.wallet, wp.name, wp.phone, wp.email, wp.address, wp.number, wp.complement, wp.district, wp.city, wp.state, wp.postal_code, wp.country, wp.updated_at
      ORDER BY d.wallet
      LIMIT $1 OFFSET $2;
    `,
      [limit, offset]
    );
    return res.json({ ok: true, wallets: rows, limit, offset });
  } catch (err) {
    console.error("admin inventories error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/api/admin/inventory/:wallet", requireAdmin, async (req, res) => {
  try {
    const wallet = req.params.wallet;
    const { rows } = await pool.query(
      `
      SELECT
        id,
        boxid AS "boxId",
        boxname AS "boxName",
        rewardname AS "rewardName",
        rewardvalue AS "rewardValue",
        mint,
        signature,
        createdat AS "createdAt",
        claim_status AS "claimStatus",
        claimed_at AS "claimedAt",
        sent_at AS "sentAt",
        mint_status AS "mintStatus",
        minted_at AS "mintedAt"
      FROM drops
      WHERE wallet = $1 AND claim_status IN ('claimed', 'sent')
      ORDER BY createdat DESC;
    `,
      [wallet]
    );
    const profile = await getProfile(wallet);
    return res.json({ ok: true, wallet, drops: rows, profile });
  } catch (err) {
    console.error("admin inventory error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.post("/api/admin/mark-sent", requireAdmin, async (req, res) => {
  try {
    const { dropId } = req.body || {};
    if (!dropId) return res.status(400).json({ ok: false, error: "invalid_params" });
    const { rows } = await pool.query("SELECT * FROM drops WHERE id = $1", [dropId]);
    const drop = rows[0];
    if (!drop) return res.status(404).json({ ok: false, error: "drop_not_found" });
    if (drop.claim_status !== "claimed") {
      return res.status(400).json({ ok: false, error: "not_in_claimed_state" });
    }
    await markDropSent(dropId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("admin mark sent error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.post("/api/shop/delist", async (req, res) => {
  try {
    const { listingId, wallet } = req.body || {};
    if (!listingId || !wallet) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }
    const listing = await getListingById(listingId);
    if (!listing || !listing.active) {
      return res.status(400).json({ ok: false, error: "listing_inactive" });
    }
    if (listing.seller !== wallet) {
      return res.status(403).json({ ok: false, error: "not_owner" });
    }
    await deactivateListing(listing.id, listing.seller, 0, 0);
    return res.json({ ok: true });
  } catch (err) {
    console.error("shop delist error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/api/quote/:lootboxId", async (req, res) => {
  try {
    const { lootboxId } = req.params;
    const currency = (req.query.currency || "sol").toLowerCase();
    const box = findBox(lootboxId);
    if (!box) return res.status(400).json({ ok: false, error: "invalid_lootbox" });
    if (!box.priceUsd || box.priceUsd <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_price" });
    }
    if (currency === "sol") {
      const solUsd = await fetchSolUsdPrice();
      const amountLamports = toLamportsFromUsd(box.priceUsd, solUsd);
      return res.json({ ok: true, lootboxId, currency, amountLamports, solUsd });
    }
    if (currency === "usdc") {
      const amountUsdc = toUsdcMinorUnits(box.priceUsd);
      const merchantAta = await getAssociatedTokenAddress(
        USDC_MINT,
        MERCHANT_WALLET,
        false
      );
      return res.json({
        ok: true,
        lootboxId,
        currency,
        amountUsdc,
        mint: USDC_MINT.toBase58(),
        merchantAta: merchantAta.toBase58(),
        decimals: USDC_DECIMALS,
      });
    }
    return res.status(400).json({ ok: false, error: "unsupported_currency" });
  } catch (err) {
    console.error("quote error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/api/profile/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!wallet) return res.status(400).json({ ok: false, error: "invalid_wallet" });
    const profile = await getProfile(wallet);
    return res.json({ ok: true, profile });
  } catch (err) {
    console.error("profile get error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

function sanitizeProfileInput(body) {
  const trimOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  return {
    wallet: trimOrNull(body.wallet),
    name: trimOrNull(body.name),
    phone: trimOrNull(body.phone),
    email: trimOrNull(body.email),
    address: trimOrNull(body.address),
    number: trimOrNull(body.number),
    complement: trimOrNull(body.complement),
    district: trimOrNull(body.district),
    city: trimOrNull(body.city),
    state: trimOrNull(body.state),
    postal_code: trimOrNull(body.postalCode),
    country: trimOrNull(body.country),
  };
}

app.post("/api/profile", async (req, res) => {
  try {
    const profile = sanitizeProfileInput(req.body || {});
    if (!profile.wallet) {
      return res.status(400).json({ ok: false, error: "invalid_wallet" });
    }
    await upsertProfile(profile);
    const saved = await getProfile(profile.wallet);
    return res.json({ ok: true, profile: saved });
  } catch (err) {
    console.error("profile upsert error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.post("/api/confirm", async (req, res) => {
  try {
    if (!MERCHANT_WALLET) {
      return res
        .status(500)
        .json({ ok: false, error: "merchant_wallet_invalid" });
    }

    const { signature, lootboxId, currency = "sol" } = req.body || {};
    const normalizedCurrency = String(currency).toLowerCase();
    if (!signature || !lootboxId) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_params" });
    }

    const box = findBox(lootboxId);
    if (!box) {
      return res.status(400).json({ ok: false, error: "invalid_lootbox" });
    }

    const tx = await getTxWithRetry(signature, 12, 800);
    if (!tx || !tx.meta || tx.meta.err) {
      return res.status(400).json({ ok: false, error: "tx_not_confirmed" });
    }

    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      k.toBase58 ? k.toBase58() : k
    );

    if (normalizedCurrency === "sol") {
      const merchantIndex = accountKeys.findIndex(
        (k) => k === MERCHANT_WALLET.toBase58()
      );
      if (merchantIndex === -1) {
        return res
          .status(400)
          .json({ ok: false, error: "merchant_not_in_tx" });
      }
      const solUsd = await fetchSolUsdPrice();
      const requiredLamports = toLamportsFromUsd(box.priceUsd, solUsd);
      const pre = tx.meta.preBalances[merchantIndex] || 0;
      const post = tx.meta.postBalances[merchantIndex] || 0;
      const deltaLamports = post - pre;
      if (deltaLamports < requiredLamports) {
        return res
          .status(400)
          .json({ ok: false, error: "insufficient_payment" });
      }
    } else if (normalizedCurrency === "usdc") {
      const requiredAmount = toUsdcMinorUnits(box.priceUsd);
      const preToken = tx.meta.preTokenBalances || [];
      const postToken = tx.meta.postTokenBalances || [];
      const merchantAta = await getAssociatedTokenAddress(
        USDC_MINT,
        MERCHANT_WALLET,
        false
      );
      const preBal = preToken.find(
        (b) =>
          b.owner === MERCHANT_WALLET.toBase58() &&
          b.mint === USDC_MINT.toBase58()
      );
      const postBal = postToken.find(
        (b) =>
          b.owner === MERCHANT_WALLET.toBase58() &&
          b.mint === USDC_MINT.toBase58()
      );
      const preUi = preBal ? Number(preBal.uiTokenAmount?.amount || 0) : 0;
      const postUi = postBal ? Number(postBal.uiTokenAmount?.amount || 0) : 0;
      const delta = postUi - preUi;
      if (delta < requiredAmount) {
        return res
          .status(400)
          .json({ ok: false, error: "insufficient_payment" });
      }
      // ensure the account in balances is the merchant ATA
      if (postBal?.accountIndex !== undefined) {
        const accountKey =
          tx.transaction.message.accountKeys[postBal.accountIndex];
        const accountStr = accountKey?.toBase58
          ? accountKey.toBase58()
          : String(accountKey);
        if (accountStr !== merchantAta.toBase58()) {
          return res
            .status(400)
            .json({ ok: false, error: "wrong_destination_account" });
        }
      }
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_currency" });
    }

    // Detect fee payer (legacy and v0 with lookups)
    const resolvePayer = () => {
      try {
        if (tx.transaction.message.getAccountKeys) {
          const keys = tx.transaction.message.getAccountKeys({
            accountKeysFromLookups: tx.meta?.loadedAddresses,
          });
          const payerKey =
            keys.payer ||
            keys.staticAccountKeys?.[0] ||
            keys[0] ||
            tx.meta?.feePayer;
          if (
            payerKey &&
            payerKey.toBase58 &&
            typeof payerKey.toBase58 === "function"
          ) {
            return payerKey.toBase58();
          }
          return payerKey ? String(payerKey) : null;
        }
        const k =
          tx.transaction.message.staticAccountKeys?.[0] ||
          tx.transaction.message.accountKeys?.[0];
        if (k && k.toBase58 && typeof k.toBase58 === "function") {
          return k.toBase58();
        }
        return k ? String(k) : null;
      } catch (e) {
        return null;
      }
    };

    const payerStr = resolvePayer();

    if (!payerStr) {
      console.error("payer_not_found_in_tx", {
        version: tx.transaction.message.version,
        hasLookups: !!tx.meta?.loadedAddresses,
        keysCount: tx.transaction.message.getAccountKeys
          ? tx.transaction.message.getAccountKeys({
              accountKeysFromLookups: tx.meta?.loadedAddresses,
            }).length
          : tx.transaction.message.accountKeys?.length,
      });
      return res
        .status(500)
        .json({ ok: false, error: "payer_not_found_in_tx" });
    }

    const existingDrop = await selectDropBySignature(signature);
    const reward = existingDrop
      ? { name: existingDrop.rewardName, value: existingDrop.rewardValue }
      : pickPercentageReward(box);
    if (!reward) {
      return res
        .status(500)
        .json({ ok: false, error: "reward_generation_failed" });
    }

    // If already minted, return the existing drop
    if (existingDrop && existingDrop.mint && existingDrop.mintStatus === "minted") {
      return res.json({
        ok: true,
        dropId: existingDrop.id,
        boxName: existingDrop.boxName,
        rewardName: existingDrop.rewardName,
        rewardValue: existingDrop.rewardValue,
        signature: existingDrop.signature,
        mint: existingDrop.mint,
        mintStatus: existingDrop.mintStatus,
      });
    }

    let dropId = existingDrop?.id || null;
    if (!dropId) {
      const insertedId = await insertDrop({
        wallet: payerStr,
        boxId: box.id,
        boxName: box.name,
        rewardName: reward.name,
        rewardValue: reward.value,
        signature,
        mint: null,
        createdAt: new Date().toISOString(),
        mintStatus: "pending",
      });
      if (insertedId) {
        dropId = insertedId;
      } else {
        const retryExisting = await selectDropBySignature(signature);
        if (retryExisting) {
          dropId = retryExisting.id;
        } else {
          return res.status(500).json({ ok: false, error: "drop_insert_failed" });
        }
      }
    }

    // Lock for minting to avoid concurrent double-mints
    const locked = await lockDropForMint(dropId);
    const afterLock = await selectDropBySignature(signature);
    if (!locked && afterLock?.mintStatus === "minting") {
      return res.status(409).json({ ok: false, error: "mint_in_progress", dropId });
    }
    if (afterLock?.mint && afterLock?.mintStatus === "minted") {
      return res.json({
        ok: true,
        dropId: afterLock.id,
        boxName: afterLock.boxName,
        rewardName: afterLock.rewardName,
        rewardValue: afterLock.rewardValue,
        signature: afterLock.signature,
        mint: afterLock.mint,
        mintStatus: afterLock.mintStatus,
      });
    }

    const mint = await mintRewardNft(reward.name, payerStr);
    if (!mint) {
      await updateDropMintStatus(dropId, { status: "failed" });
      return res.status(502).json({ ok: false, error: "mint_failed", dropId });
    }

    const saved = await updateDropMintStatus(dropId, {
      status: "minted",
      mint,
    });

    return res.json({
      ok: true,
      dropId: saved?.id || dropId,
      boxName: saved?.boxName || box.name,
      rewardName: saved?.rewardName || reward.name,
      rewardValue: saved?.rewardValue || reward.value,
      signature: saved?.signature || signature,
      mint: saved?.mint || mint,
      mintStatus: saved?.mintStatus || "minted",
    });
  } catch (err) {
    console.error("confirm error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.post("/api/mint/retry", async (req, res) => {
  try {
    const { dropId, wallet } = req.body || {};
    if (!dropId || !wallet) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }
    const drop = await selectDropById(dropId);
    if (!drop) return res.status(404).json({ ok: false, error: "drop_not_found" });
    if (drop.wallet !== wallet) {
      return res.status(403).json({ ok: false, error: "not_owner" });
    }
    if (drop.mint && drop.mintStatus === "minted") {
      return res.json({ ok: true, drop });
    }
    const locked = await lockDropForMint(dropId);
    const refreshed = await selectDropById(dropId);
    if (!locked && refreshed?.mintStatus === "minting") {
      return res.status(409).json({ ok: false, error: "mint_in_progress", dropId });
    }
    const mint = await mintRewardNft(drop.rewardName, drop.wallet);
    if (!mint) {
      await updateDropMintStatus(dropId, { status: "failed" });
      return res.status(502).json({ ok: false, error: "mint_failed", dropId });
    }
    const saved = await updateDropMintStatus(dropId, {
      status: "minted",
      mint,
    });
    return res.json({ ok: true, drop: saved || refreshed });
  } catch (err) {
    console.error("mint retry error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});
