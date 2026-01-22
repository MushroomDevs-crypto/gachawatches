import { useEffect, useMemo, useRef, useState } from "react";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import {
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  getAssociatedTokenAddress,
  createApproveInstruction,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import "./App.css";
import commonBox from "./assets/commonbox.png";
import rareBox from "./assets/rarebox.png";
import twitterIcon from "./assets/social/twitter.png";
import dexscreenerIcon from "./assets/social/dexscreener.png";
import logo from "./assets/logo.png";
import box2PricesRaw from "./box2Prices.json";

const box1Images = import.meta.glob("./assets/box1/**/*.{png,jpg,jpeg}", {
  eager: true,
  import: "default",
});


const box2Images = import.meta.glob("./assets/box2/**/*.{png,jpg,jpeg}", {
  eager: true,
  import: "default",
});
const box2ImagesByFolder = box2Images;

const BOX2_PRICE_MAP = Object.entries(box2PricesRaw || {}).reduce(
  (acc, [key, value]) => {
    acc[normalizeName(key)] = value;
    return acc;
  },
  {}
);

function getBox2Image(name, fallback) {
  const needle = `/${normalizeName(name)}.`;
  const foundKey = Object.keys(box2Images).find((k) =>
    normalizeName(k).includes(needle)
  );
  return foundKey ? box2Images[foundKey] : fallback;
}

function getBox1Image(name, fallback) {
  const needle = `/${normalizeName(name)}.`;
  const foundKey = Object.keys(box1Images).find((k) =>
    normalizeName(k).includes(needle)
  );
  return foundKey ? box1Images[foundKey] : fallback;
}

function getBox2Names(folder) {
  const names = Object.keys(box2ImagesByFolder)
    .filter((k) => k.includes(`/box2/${folder}/`))
    .map((k) => k.split("/").pop()?.replace(/\.[^.]+$/, ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return names;
}

function buildBox2Rewards(names, chance, fallback, rarity, rarityChance) {
  return names.map((name, idx) => ({
    name,
    value: BOX2_PRICE_MAP[normalizeName(name)] || 0.001,
    chance,
    rarityChance,
    image: getBox2Image(name, fallback),
    order: idx,
    rarity,
  }));
}

const BOX2_UNCOMMON_NAMES = getBox2Names("uncommon");
const BOX2_RARE_NAMES = getBox2Names("rares");
const BOX2_EPIC_NAMES = getBox2Names("epics");
const BOX2_LEGENDARY_NAMES = getBox2Names("legendaries");

function perItemChance(totalChance, count) {
  return count > 0 ? totalChance / count : 0;
}


const MERCHANT_WALLET_RAW =
  import.meta.env.VITE_MERCHANT_WALLET ||
  "F4e1YgUmL1TiDf8FBkg3TYfLxzw3jCm1GkT8ZdJLkre9";


const API_BASE = import.meta.env.VITE_API_BASE || "";
const DELEGATE_WALLET_RAW =
  import.meta.env.VITE_DELEGATE_WALLET || MERCHANT_WALLET_RAW;
const USDC_MINT =
  import.meta.env.VITE_USDC_MINT ||
  "EPjFWdd5AufqSSqeM2qN3xqWg7iP5sQPhgSRXJ1nZgXn";
const USDC_DECIMALS = 6;
const ABOUT_MODAL_KEY = "lootbox_about_seen";
const TEST_PRICE_USD = Number(import.meta.env.VITE_TEST_PRICE_USD || 0);
const SPIN_DURATION_MS = 4200;
const RARITY_DISPLAY_CHANCES = {
  common: 85,
  uncommon: 10,
  rare: 4.9,
  epic: 0.1,
  legendary: 0.1,
};


function normalizeName(str) {

  return (str || "")

    .trim()

    .toLowerCase()

    .normalize("NFD")

    .replace(/[\u0300-\u036f]/g, "");

}



function getRarityClass(name) {
  const found = findRewardByName(name);
  if (found?.rarity) return `rarity-${found.rarity}`;
  const n = normalizeName(name);
  if (n.includes("legendary")) return "rarity-legendary";
  if (n.includes("epic")) return "rarity-epic";
  if (n.includes("rare")) return "rarity-rare";
  if (n.includes("uncommon")) return "rarity-uncommon";
  return "rarity-common";
}


function getRewardImage(boxId, rewardName) {
  const box = LOOTBOXES.find((b) => b.id === boxId);
  if (!box) return commonBox;
  const found = box.rewards.find(
    (r) => normalizeName(r.name) === normalizeName(rewardName)
  );
  return (found && found.image) || box.image || commonBox;
}

function formatPriceLabel(box, quote) {
  const usd = box.priceUsd?.toFixed ? box.priceUsd.toFixed(2) : box.priceUsd;
  if (quote && quote.lootboxId === box.id && quote.currency === "usdc") {
    return `${(quote.amountUsdc / 10 ** USDC_DECIMALS).toFixed(2)} USDC`;
  }
  return `${usd} USDC`;
}

function formatChance(reward) {
  const c = Number(
    reward?.rarityChance !== undefined ? reward.rarityChance : reward?.chance
  );
  if (!Number.isFinite(c)) return `${reward?.chance}%`;
  const rarity = (reward?.rarity || "").toLowerCase();
  if (rarity === "epic" || rarity === "legendary") return `${c.toFixed(4)}%`;
  if (Number.isInteger(c)) return `${c}%`;
  return `${c.toFixed(2)}%`;
}

function findRewardByName(name) {
  const target = normalizeName(name);
  for (const box of LOOTBOXES) {
    const found = box.rewards.find(
      (r) => normalizeName(r.name) === target
    );
    if (found) return found;
  }
  return null;
}

function buildRewards(prefix, count, chance, startValue, imageResolver, fallback) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${i + 1}`,
    value: 0.001,
    chance,
    image: imageResolver(`${prefix}${i + 1}`, fallback),
    rarity: prefix.replace(/[^a-z]/gi, "").toLowerCase(),
  }));
}


const BASE_LOOTBOXES = [
  {
    id: "common",
    name: "Entry level Box",
    priceUsd: 50,
    colorClass: "lootbox-common",
    image: commonBox,
    rarityChances: [
      { label: "Common", chance: "85%" },
      { label: "Uncommon", chance: "10%" },
      { label: "Rare", chance: "4.9%" },
      { label: "Epic", chance: "0.1%" },
    ],
    rewards: [
      { name: "CASIO A168WEM-7", value: 35, chance: 14.1667, image: getBox1Image("CASIO A168WEM-7", commonBox) },
      { name: "CASIO FT-500WC-1BV", value: 37.5, chance: 14.1667, image: getBox1Image("CASIO FT-500WC-1BV", commonBox) },
      { name: "CASIO  LWS-1200H-1A2V", value: 37.5, chance: 14.1667, image: getBox1Image("CASIO  LWS-1200H-1A2V", commonBox) },
      { name: "CASIO W-217H-5AV", value: 30, chance: 14.1667, image: getBox1Image("CASIO W-217H-5AV", commonBox) },
      { name: "CASIO W-218H-3BV", value: 30, chance: 14.1667, image: getBox1Image("CASIO W-218H-3BV", commonBox) },
      { name: "G-SHOCK GD-100GB-1", value: 70, chance: 14.1667, image: getBox1Image("G-SHOCK GD-100GB-1", commonBox) },
      { name: "CASIO AQ-S820W-5AV", value: 45, chance: 1.25, image: getBox1Image("CASIO AQ-S820W-5AV", commonBox) },
      { name: "CASIO B640WB-1B", value: 30, chance: 1.25, image: getBox1Image("CASIO B640WB-1B", commonBox) },
      { name: "CASIO LA680WGA-9", value: 30, chance: 1.25, image: getBox1Image("CASIO LA680WGA-9", commonBox) },
      { name: "CASIO MDV-106B-1A2V", value: 90, chance: 1.25, image: getBox1Image("CASIO MDV-106B-1A2V", commonBox) },
      { name: "Easy Reader Day Date 35mm Expansion Band Watch", value: 55, chance: 1.25, image: getBox1Image("Easy Reader Day Date 35mm Expansion Band Watch", commonBox) },
      { name: "Monopoly x Timex MK1 36mm Fabric Strap", value: 52.5, chance: 1.25, image: getBox1Image("Monopoly x Timex MK1 36mm Fabric Strap", commonBox) },
      { name: "Timex x Peanuts Snoopy 38mm Fabric Strap", value: 52.5, chance: 1.25, image: getBox1Image("Timex x Peanuts Snoopy 38mm Fabric Strap", commonBox) },
      { name: "Weekender 38mm Fabric Strap", value: 45, chance: 1.25, image: getBox1Image("Weekender 38mm Fabric Strap", commonBox) },
      { name: "Citizen Garrison Eco-Drive 43mm - Black on Bracelet", value: 200, chance: 0.49, image: getBox1Image("Citizen Garrison Eco-Drive 43mm - Black on Bracelet", commonBox) },
      { name: "Orient Bambino 38mm - White on Leather Strap", value: 140, chance: 0.49, image: getBox1Image("Orient Bambino 38mm - White on Leather Strap", commonBox) },
      { name: "Seiko SNKN37 Recraft Series 43.5mm - Blue on Leather Strap", value: 160, chance: 0.49, image: getBox1Image("Seiko SNKN37 Recraft Series 43.5mm - Blue on Leather Strap", commonBox) },
      { name: "Timex IRONMAN Classic 30-Lap 38mm Recycled Fabric Strap", value: 47.5, chance: 0.49, image: getBox1Image("Timex IRONMAN Classic 30-Lap 38mm Recycled Fabric Strap", commonBox) },
      { name: "Timex Legacy Ocean x Peanuts Recycled Material 42mm - Blue on Bracelet", value: 65, chance: 0.49, image: getBox1Image("Timex Legacy Ocean x Peanuts Recycled Material 42mm - Blue on Bracelet", commonBox) },
      { name: "Timex Q Timex Gold-Tone 36mm - Blue on Bracelet", value: 185, chance: 0.49, image: getBox1Image("Timex Q Timex Gold-Tone 36mm - Blue on Bracelet", commonBox) },
      { name: "Timex Q Timex Gold-Tone 36mm - Green on Bracelet", value: 185, chance: 0.49, image: getBox1Image("Timex Q Timex Gold-Tone 36mm - Green on Bracelet", commonBox) },
      { name: "Timex x Fortnite Acadia 40mm Fabric Strap", value: 75, chance: 0.49, image: getBox1Image("Timex x Fortnite Acadia 40mm Fabric Strap", commonBox) },
      { name: "Timex x Fortnite T80 36mm Stainless Steel Bracelet", value: 75, chance: 0.49, image: getBox1Image("Timex x Fortnite T80 36mm Stainless Steel Bracelet", commonBox) },
      { name: "Waste More Time Watch Timex Legacy Ocean 42mm with Recycled Plastic Bracelet", value: 55, chance: 0.49, image: getBox1Image("Waste More Time Watch Timex Legacy Ocean 42mm with Recycled Plastic Bracelet", commonBox) },
      { name: "Bulova Hack Watch 38mm - Black on Leather Strap", value: 275, chance: 0.0077, image: getBox1Image("Bulova Hack Watch 38mm - Black on Leather Strap", commonBox) },
      { name: "Citizen Zenshin Chrono Super Titanium 42.4mm - Blue on Bracelet", value: 325, chance: 0.0077, image: getBox1Image("Citizen Zenshin Chrono Super Titanium 42.4mm - Blue on Bracelet", commonBox) },
      { name: "Frederique Constant Classics Index Automatic Steel 39mm - Green on Bracelet", value: 1450, chance: 0.0077, image: getBox1Image("Frederique Constant Classics Index Automatic Steel 39mm - Green on Bracelet", commonBox) },
      { name: "Hamilton Jazzmaster Open Heart Auto 40mm - Blue on Bracelet", value: 950, chance: 0.0077, image: getBox1Image("Hamilton Jazzmaster Open Heart Auto 40mm - Blue on Bracelet", commonBox) },
      { name: "Hamilton Khaki Field Mechanical Brown PVD 38mm - Blrown on One-Piece Textile Strap", value: 650, chance: 0.0077, image: getBox1Image("Hamilton Khaki Field Mechanical Brown PVD 38mm - Blrown on One-Piece Textile Strap", commonBox) },
      { name: "Longines HydroConquest 41mm - Green on Bracelet", value: 1150, chance: 0.0077, image: getBox1Image("Longines HydroConquest 41mm - Green on Bracelet", commonBox) },
      { name: "Longines Mini DolceVita 29mm - Silver Fliniqué on Leather Strap", value: 1500, chance: 0.0077, image: getBox1Image("Longines Mini DolceVita 29mm - Silver Fliniqué on Leather Strap", commonBox) },
      { name: "Muhle Glashutte 29er 36.6mm - White on Bracelet", value: 1750, chance: 0.0077, image: getBox1Image("Muhle Glashutte 29er 36.6mm - White on Bracelet", commonBox) },
      { name: "Omega Speedmaster Day Date", value: 1800, chance: 0.0077, image: getBox1Image("Omega Speedmaster Day Date", commonBox) },
      { name: "Sternglas Hamburg Mecha-Quartz Chrono 42mm - Green on Leather Strap", value: 375, chance: 0.0077, image: getBox1Image("Sternglas Hamburg Mecha-Quartz Chrono 42mm - Green on Leather Strap", commonBox) },
      { name: "Sternglas Lumatik Automatic 38mm - Blue on Nylon Strap", value: 375, chance: 0.0077, image: getBox1Image("Sternglas Lumatik Automatic 38mm - Blue on Nylon Strap", commonBox) },
      { name: "Tissot PRX Powermatic 80 35mm - Gold-Tone on Bracelet", value: 400, chance: 0.0077, image: getBox1Image("Tissot PRX Powermatic 80 35mm - Gold-Tone on Bracelet", commonBox) },
      { name: "Tissot PRX Quartz 40mm - Silver on Bracelet", value: 262.5, chance: 0.0077, image: getBox1Image("Tissot PRX Quartz 40mm - Silver on Bracelet", commonBox) },
    ],
  },
  {
    id: "rare",
    name: "Swiss box",
    priceUsd: 250,
    colorClass: "lootbox-rare",
    image: rareBox,

    rarityChances: [
      { label: "Uncommon", chance: "85%" },
      { label: "Rare", chance: "10%" },
      { label: "Epic", chance: "4.9%" },
      { label: "Legendary", chance: "0.1%" },
    ],
    rewards: [
      ...buildBox2Rewards(
        BOX2_UNCOMMON_NAMES,
        perItemChance(85, BOX2_UNCOMMON_NAMES.length),
        rareBox,
        "uncommon",
        85
      ),
      ...buildBox2Rewards(
        BOX2_RARE_NAMES,
        perItemChance(10, BOX2_RARE_NAMES.length),
        rareBox,
        "rare",
        10
      ),
      ...buildBox2Rewards(
        BOX2_EPIC_NAMES,
        perItemChance(4.9, BOX2_EPIC_NAMES.length),
        rareBox,
        "epic",
        4.9
      ),
      ...buildBox2Rewards(
        BOX2_LEGENDARY_NAMES,
        perItemChance(0.1, BOX2_LEGENDARY_NAMES.length),
        rareBox,
        "legendary",
        0.1
      ),
    ],
  },
];

const LOOTBOXES = BASE_LOOTBOXES.map((box) => {
  const priceUsd = TEST_PRICE_USD > 0 ? TEST_PRICE_USD : box.priceUsd;
  const rewards = (TEST_PRICE_USD > 0
    ? box.rewards.map((r) => ({ ...r, value: TEST_PRICE_USD }))
    : box.rewards
  ).map((r) => {
    const rarityKey = (r.rarity || "").toLowerCase();
    const rarityChance =
      r.rarityChance !== undefined ? r.rarityChance : RARITY_DISPLAY_CHANCES[rarityKey];
    return rarityChance !== undefined ? { ...r, rarityChance } : r;
  });
  return { ...box, priceUsd, rewards };
});

(function annotateBox1Rarities() {
  const box = LOOTBOXES.find((b) => b.id === "common");
  if (!box) return;
  const buckets = [
    { end: 6, rarity: "common" },
    { end: 14, rarity: "uncommon" },
    { end: 24, rarity: "rare" },
    { end: box.rewards.length, rarity: "epic" },
  ];
  let start = 0;
  for (const bucket of buckets) {
    for (let i = start; i < Math.min(bucket.end, box.rewards.length); i++) {
      box.rewards[i].rarity = bucket.rarity;
    }
    start = bucket.end;
  }
})();

(function applyDisplayRarityChances() {
  const common = LOOTBOXES.find((b) => b.id === "common");
  if (!common) return;
  common.rewards = common.rewards.map((r) => {
    const rarityKey = (r.rarity || "").toLowerCase();
    const rarityChance =
      r.rarityChance !== undefined
        ? r.rarityChance
        : RARITY_DISPLAY_CHANCES[rarityKey];
    return rarityChance !== undefined ? { ...r, rarityChance } : r;
  });
})();

function pickPercentageReward(box) {
  const random = Math.random() * 100;
  let sum = 0;


  for (const reward of box.rewards) {

    sum += reward.chance;

    if (random <= sum) {

      return reward;

    }

  }



  return box.rewards[box.rewards.length - 1];

}



function App() {

  const { publicKey, connected, connecting, sendTransaction, disconnect } = useWallet();

  const { connection } = useConnection();

  const merchantWallet = useMemo(() => {

    try {

      return new PublicKey(MERCHANT_WALLET_RAW);

    } catch (e) {

      return null;

    }

  }, []);

  const [inventory, setInventory] = useState([]);
  const [message, setMessage] = useState("");

  const [lastDrop, setLastDrop] = useState(null);

  const [history, setHistory] = useState([]);
  const [loadingBoxId, setLoadingBoxId] = useState(null);
  const [mintRetryId, setMintRetryId] = useState(null);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [imagesPreloaded, setImagesPreloaded] = useState(false);
  const getInitialTab = () => {
    if (typeof window !== "undefined" && window.location.pathname.toLowerCase().includes("/admin")) {
      return "admin";
    }
    return "cases";
  };
  const [activeTab, setActiveTab] = useState(getInitialTab());
  const [delegateWallet, setDelegateWallet] = useState(DELEGATE_WALLET_RAW);
  const currency = "usdc";
  const [quote, setQuote] = useState(null);
  const [adminToken, setAdminToken] = useState("");
  const [adminInventory, setAdminInventory] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminWalletFilter, setAdminWalletFilter] = useState("");
  const [usdcBalance, setUsdcBalance] = useState(0);
  const [profile, setProfile] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
    number: "",
    complement: "",
    district: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
  });
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileMode, setProfileMode] = useState("edit");
  const [claimDropId, setClaimDropId] = useState(null);
  const [spinState, setSpinState] = useState({
    open: false,
    items: [],
    targetIndex: 0,
    translate: 0,
    animate: false,
    boxName: "",

    rewardName: "",

  });
  const spinTrackRef = useRef(null);
  const connectResetRef = useRef(null);

  const [selectedBox, setSelectedBox] = useState(null);
  const [showDropModal, setShowDropModal] = useState(false);
  const [pendingDrop, setPendingDrop] = useState(null);
  const [trialDrop, setTrialDrop] = useState(null);
  const [showTrialModal, setShowTrialModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [loadingTrialId, setLoadingTrialId] = useState(null);

  useEffect(() => {
    if (!connecting) {
      if (connectResetRef.current) {
        clearTimeout(connectResetRef.current);
        connectResetRef.current = null;
      }
      return;
    }

    connectResetRef.current = setTimeout(() => {
      if (!connected) {
        disconnect().catch(() => {});
        setMessage("Connection timed out. Please retry in Phantom.");
      }
    }, 8000);

    return () => {
      if (connectResetRef.current) {
        clearTimeout(connectResetRef.current);
        connectResetRef.current = null;
      }
    };
  }, [connecting, connected, disconnect]);

  useEffect(() => {
    function handleVisibility() {
      if (
        document.visibilityState === "visible" &&
        connecting &&
        !connected
      ) {
        disconnect().catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connecting, connected, disconnect]);



  useEffect(() => {
    let cancelled = false;
    let intervalId;

    async function loadUsdcBalance() {
      if (!connected || !publicKey) {
        setUsdcBalance(0);
        return;
      }
      try {
        const mintPk = new PublicKey(USDC_MINT);
        const resp = await connection.getParsedTokenAccountsByOwner(publicKey, {
          mint: mintPk,
        });
        const total = resp.value.reduce((sum, { account }) => {
          const info = account.data?.parsed?.info;
          const tokenAmount = info?.tokenAmount;
          const amount = Number(tokenAmount?.amount || 0);
          const decimals =
            typeof tokenAmount?.decimals === "number"
              ? tokenAmount.decimals
              : USDC_DECIMALS;
          return sum + amount / 10 ** decimals;
        }, 0);
        if (!cancelled) {
          setUsdcBalance(total);
        }
      } catch {
        if (!cancelled) {
          setUsdcBalance(0);
        }
      }
    }

    if (connected && publicKey) {
      loadUsdcBalance();
      intervalId = setInterval(loadUsdcBalance, 8000);
    } else {
      setUsdcBalance(0);
    }

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [connected, publicKey, connection]);



  useEffect(() => {
    if (!connected || !publicKey || !API_BASE) {
      setInventory([]);
      setProfile({
        name: "",
        phone: "",
        email: "",
        address: "",
        number: "",
        complement: "",
        district: "",
        city: "",
        state: "",
        postalCode: "",
        country: "",
      });
      return;
    }
    let cancelled = false;
    async function fetchInventory() {
      setLoadingInventory(true);
      try {

        const res = await fetch(`${API_BASE}/api/inventory/${publicKey.toBase58()}`);

        if (!res.ok) throw new Error("Failed to load inventory");

        const data = await res.json();

        if (!cancelled && data.ok) {

          setInventory(data.drops || []);

        }

      } catch (err) {

        if (!cancelled) {

          setInventory([]);

        }

      } finally {

        if (!cancelled) setLoadingInventory(false);

      }

    }
    fetchInventory();
  }, [connected, publicKey]);

  useEffect(() => {
    async function loadAdminInventories() {
      if (!API_BASE || !adminToken || activeTab !== "admin") return;
      await fetchAdminInventoriesAll();
    }
    loadAdminInventories();
  }, [API_BASE, adminToken, activeTab]);

  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch(`${API_BASE}/api/config`);
        const data = await res.json();
        if (data.ok && data.delegateWallet) {
          setDelegateWallet(data.delegateWallet);

        }

      } catch (e) {

        // ignore, fallback to env

      }

    }
    if (API_BASE) loadConfig();
  }, []);

  useEffect(() => {
    async function loadProfile() {
      if (!API_BASE || !publicKey) return;
      setProfileLoading(true);
      setProfileMessage("");
      try {
        const res = await fetch(`${API_BASE}/api/profile/${publicKey.toBase58()}`);
        const data = await res.json();
        if (data.ok && data.profile) {
          setProfile({
            name: data.profile.name || "",
            phone: data.profile.phone || "",
            email: data.profile.email || "",
            address: data.profile.address || "",
            number: data.profile.number || "",
            complement: data.profile.complement || "",
            district: data.profile.district || "",
            city: data.profile.city || "",
            state: data.profile.state || "",
            postalCode: data.profile.postalCode || "",
            country: data.profile.country || "",
          });
        }
      } catch (err) {
        // ignore
      } finally {
        setProfileLoading(false);
      }
    }
    loadProfile();
  }, [API_BASE, publicKey]);

  useEffect(() => {
    if (!selectedBox || !API_BASE) return;
    fetchQuote(selectedBox.id).catch(() => {});
  }, [selectedBox]);

  async function fetchQuote(boxId) {
    if (!API_BASE) throw new Error("API not configured");
    const res = await fetch(
      `${API_BASE}/api/quote/${boxId}?currency=usdc`
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to quote price");
    setQuote(data);
    return data;
  }

  useEffect(() => {
    if (imagesPreloaded) return;
    const seen = new Set();
    LOOTBOXES.forEach((box) => {
      if (box.image && !seen.has(box.image)) {
        const img = new Image();

        img.src = box.image;

        seen.add(box.image);

      }

      box.rewards.forEach((reward) => {

        if (reward.image && !seen.has(reward.image)) {

          const img = new Image();

          img.src = reward.image;

          seen.add(reward.image);

        }

      });

    });

    setImagesPreloaded(true);

  }, [imagesPreloaded]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem(ABOUT_MODAL_KEY);
    if (!seen) {
      setShowAboutModal(true);
      window.localStorage.setItem(ABOUT_MODAL_KEY, "true");
    }
  }, []);

  async function handleFreeTrial(boxId) {
    const box = LOOTBOXES.find((b) => b.id === boxId);
    if (!box) return;
    setLoadingTrialId(boxId);
    try {
      const simulated = pickPercentageReward(box) || box.rewards[0];
      triggerSpinAnimation(box, simulated.name, simulated.value);
      setMessage(`Free try: ${box.name}. No item or NFT included.`);
      setTrialDrop({
        boxName: box.name,
        rewardName: simulated.name,
        rewardValue: simulated.value,
        image: getRewardImage(box.id, simulated.name) || box.image || commonBox,
      });
      setShowTrialModal(true);
    } catch (err) {
      setMessage("Unable to run the free try at this time.");
    } finally {
      setTimeout(() => {
        setLoadingTrialId((prev) => (prev === boxId ? null : prev));
      }, 5000);
    }
  }


  async function handleBuy(boxId) {
    const box = LOOTBOXES.find((b) => b.id === boxId);
    if (!box) return;

    if (!merchantWallet) {
      setMessage("Merchant wallet is not configured. Contact support.");
      return;
    }

    if (!connected || !publicKey) {
      setMessage("Connect a wallet to open a case.");
      return;
    }

    setLoadingBoxId(box.id);
    setMessage(`Processing your ${box.name}...`);

    try {
      const quoteData = await fetchQuote(box.id);

      const amount = quoteData.amountUsdc;
      if (!amount || amount <= 0) throw new Error("Invalid USDC quote");
      const requiredUsdc = amount / 10 ** USDC_DECIMALS;
      if (usdcBalance + 1e-6 < requiredUsdc) {
        setMessage(
          `Insufficient USDC. You need ${requiredUsdc.toFixed(
            2
          )} USDC to open this box.`
        );
        return;
      }

      const balanceLamports = await connection.getBalance(publicKey);
      const solBalance = balanceLamports / LAMPORTS_PER_SOL;
      const minSolFee =
        Number(import.meta.env.VITE_MIN_SOL_FEE_SOL || 0.0025);
      if (solBalance + 1e-6 < minSolFee) {
        setMessage(
          `Insufficient SOL for network fee. Need at least ${minSolFee} SOL.`
        );
        return;
      }

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("finalized");

      const tx = new Transaction();
      const mintPk = new PublicKey(quoteData.mint || USDC_MINT);
      const merchantAta = new PublicKey(quoteData.merchantAta);
      const ownerAta = await getAssociatedTokenAddress(mintPk, publicKey);
      const ataInfo = await connection.getAccountInfo(merchantAta);
      if (!ataInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            merchantAta,
            merchantWallet,
            mintPk
          )
        );
      }
      tx.add(
        createTransferCheckedInstruction(
          ownerAta,
          mintPk,
          merchantAta,
          publicKey,
          amount,
          USDC_DECIMALS
        )
      );

      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signature = await sendTransaction(tx, connection, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      const response = await fetch(`${API_BASE}/api/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ signature, lootboxId: box.id, currency }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const errCode = body?.error || "confirm_failed";
        throw new Error(`Backend rejected: ${errCode}`);
      }

      const data = await response.json();
      const dropId = data.dropId || data.id || null;
      const result = {
        boxName: data.boxName,
        rewardName: data.rewardName,
        rewardValue: data.rewardValue,
        mint: data.mint,
        dropId,
        timestamp: new Date().toLocaleTimeString(),
      };
      const rewardImage = getRewardImage(box.id, result.rewardName);

      setLastDrop(result);
      setPendingDrop({
        dropId,
        rewardName: result.rewardName,
        rewardValue: result.rewardValue,
        boxName: result.boxName,
        mint: result.mint,
        image: rewardImage,
      });
      setShowDropModal(true);
      setHistory((prev) => [result, ...prev].slice(0, 10));
      setInventory((prev) => [
        {
          id: dropId || Math.random().toString(36).slice(2),
          boxId: box.id,
          boxName: box.name,
          rewardName: result.rewardName,
          rewardValue: result.rewardValue,
          signature,
          mint: data.mint,
          mintStatus: data.mintStatus || (data.mint ? "minted" : "pending"),
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      triggerSpinAnimation(box, result.rewardName, result.rewardValue);
      setMessage(
        `Confirmed (tx: ${signature.slice(
          0,
          6
        )}...)! ${box.name} opened and you got ${result.rewardName}.`
      );
      setSelectedBox(box);
    } catch (err) {
      console.error(err);
      setMessage(
        err?.message || "Could not complete the purchase. Try again."
      );
    } finally {
      setLoadingBoxId(null);
    }
  }


  async function approveDelegate(mint) {
    if (!delegateWallet) throw new Error("Delegate wallet not configured");
    if (!publicKey) throw new Error("Wallet not connected");
    const mintPk = new PublicKey(mint);
    const ata = await getAssociatedTokenAddress(mintPk, publicKey);
    const approveIx = createApproveInstruction(

      ata,

      new PublicKey(delegateWallet),

      publicKey,

      1

    );

    const tx = new Transaction().add(approveIx);

    const { blockhash, lastValidBlockHeight } =

      await connection.getLatestBlockhash("finalized");

    tx.recentBlockhash = blockhash;

    tx.feePayer = publicKey;

    const sig = await sendTransaction(tx, connection, {

      skipPreflight: false,

      preflightCommitment: "confirmed",

    });

    await connection.confirmTransaction(

      { signature: sig, blockhash, lastValidBlockHeight },

      "confirmed"

    );

    return sig;

  }



  async function handleSellback(dropId, rewardValue) {
    if (!API_BASE || !publicKey) {
      setMessage("API not configured or wallet not connected.");
      return false;
    }
    const drop = inventory.find((d) => d.id === dropId || d.dropId === dropId);

    if (!drop?.mint) {

      setMessage("This item does not have a mint registered yet.");

      return false;

    }

    setLoadingBoxId(`sell-${dropId}`);

    try {

      await approveDelegate(drop.mint);

      const res = await fetch(`${API_BASE}/api/sellback`, {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ dropId, wallet: publicKey.toBase58() }),

      });

      const data = await res.json();

      if (!data.ok) throw new Error(data.error || "Sellback failed");

      setMessage(
        `Sold back for ${(Number(rewardValue) * 0.7).toFixed(2)} USDC (tx ${data.signature.slice(
          0,
          6
        )}...)`
      );
      // refresh inventory
      fetch(`${API_BASE}/api/inventory/${publicKey.toBase58()}`)
        .then((r) => r.json())
        .then((d) => d.ok && setInventory(d.drops || []))
        .catch(() => {});
      if (pendingDrop && pendingDrop.dropId && pendingDrop.dropId === dropId) {
        setPendingDrop(null);
        setShowDropModal(false);
      }
      return true;
    } catch (err) {
      console.error(err);
      setMessage(err?.message || "Could not sell back.");
      return false;
    } finally {
      setLoadingBoxId(null);
    }
  }

  async function handleMintRetry(dropId) {
    if (!API_BASE || !publicKey) {
      setMessage("API not configured or wallet not connected.");
      return;
    }
    setMintRetryId(dropId);
    try {
      const res = await fetch(`${API_BASE}/api/mint/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dropId, wallet: publicKey.toBase58() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Mint retry failed");
      }
      const updatedDrop = data.drop;
      if (updatedDrop) {
        setInventory((prev) =>
          prev.map((d) =>
            d.id === dropId || d.dropId === dropId ? { ...d, ...updatedDrop } : d
          )
        );
      }
      setMessage("NFT minted successfully.");
    } catch (err) {
      setMessage(err?.message || "Mint retry failed");
    } finally {
      setMintRetryId(null);
    }
  }

  function closeDropModal() {
    setPendingDrop(null);
    setShowDropModal(false);
  }

  function closeTrialModal() {
    setTrialDrop(null);
    setShowTrialModal(false);
  }

  function closeAboutModal() {
    setShowAboutModal(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ABOUT_MODAL_KEY, "true");
    }
  }

  async function handleClaim(dropId) {
    if (!API_BASE || !publicKey) {
      setMessage("API not configured or wallet not connected.");
      return;
    }
    const drop = inventory.find((d) => d.id === dropId || d.dropId === dropId);
    if (!drop?.mint) {
      setMessage("This item does not have a mint registered yet.");
      return;
    }
    setLoadingBoxId(`claim-${dropId}`);
    try {
      const buildRes = await fetch(`${API_BASE}/api/claim-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dropId, wallet: publicKey.toBase58() }),
      });
      const buildData = await buildRes.json();
      if (!buildData.ok) throw new Error(buildData.error || "Could not build claim tx.");

      const tx = Transaction.from(Buffer.from(buildData.tx, "base64"));
      const sig = await sendTransaction(tx, connection, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(sig, "confirmed");

      const confirmRes = await fetch(`${API_BASE}/api/claim-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dropId,
          wallet: publicKey.toBase58(),
          signature: sig,
        }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmData.ok) {
        const detail =
          typeof confirmData.detail === "string"
            ? confirmData.detail
            : confirmData.detail
            ? JSON.stringify(confirmData.detail)
            : "";
        throw new Error(confirmData.error + (detail ? `: ${detail}` : ""));
      }

      setMessage("Item claimado. NFT movido para a carteira da casa.");
      fetch(`${API_BASE}/api/inventory/${publicKey.toBase58()}`)
        .then((r) => r.json())
        .then((d) => d.ok && setInventory(d.drops || []))
        .catch(() => {});
    } catch (err) {
      console.error(err);
      setMessage(err?.message || "Could not claim item.");
    } finally {
      setLoadingBoxId(null);
    }
  }

  async function fetchAdminInventoryByWallet(wallet) {
    if (!API_BASE || !adminToken || !wallet) return;
    setAdminLoading(true);
    setAdminError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/inventory/${wallet}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to load wallet");
      setAdminInventory([{ wallet: data.wallet, drops: data.drops || [] }]);
    } catch (err) {
      setAdminInventory([]);
      setAdminError(err?.message || "Could not load wallet");
    } finally {
      setAdminLoading(false);
    }
  }

  async function fetchAdminInventoriesAll() {
    if (!API_BASE || !adminToken) return;
    setAdminLoading(true);
    setAdminError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/inventories`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to load admin data");
      setAdminInventory(data.wallets || []);
    } catch (err) {
      setAdminInventory([]);
      setAdminError(err?.message || "Could not load admin data");
    } finally {
      setAdminLoading(false);
    }
  }

  async function markSent(dropId) {
    if (!API_BASE || !adminToken) return;
    try {
      const res = await fetch(`${API_BASE}/api/admin/mark-sent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ dropId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Could not mark sent");
      // refresh admin data
      fetchAdminInventoriesAll();
    } catch (err) {
      setAdminError(err?.message || "Could not mark sent");
    }
  }

    async function saveProfile(silent = false) {
    if (!API_BASE || !publicKey) {
      if (!silent) setProfileMessage("Connect a wallet to save profile.");
      return false;
    }
    if (!silent) setProfileMessage("");
    setProfileLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), ...profile }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save profile");
      if (!silent) setProfileMessage("Data saved.");
      return true;
    } catch (err) {
      if (!silent) setProfileMessage(err?.message || "Error saving profile.");
      return false;
    } finally {
      setProfileLoading(false);
    }
  }

  function openProfileModal() {
    setProfileMode("edit");
    setClaimDropId(null);
    setShowProfileModal(true);
  }

  function openClaimModal(dropId) {
    setProfileMode("claim");
    setClaimDropId(dropId);
    setShowProfileModal(true);
  }

  function closeProfileModal() {
    setShowProfileModal(false);
    setClaimDropId(null);
    setProfileMode("edit");
  }

  async function submitProfileModal() {
    const ok = await saveProfile(false);
    if (!ok) return;
    if (profileMode === "claim" && claimDropId) {
      await handleClaim(claimDropId);
    }
    closeProfileModal();
  }

  function findRewardAsset(box, rewardName, rewardValue) {

    const fallbackImage = box.image || commonBox;

    const nameLc = normalizeName(rewardName);

    const valueNum =

      typeof rewardValue === "number"

        ? rewardValue

        : Number.parseFloat(rewardValue);



    // direct match by incoming name

    const byName = box.rewards.find(

      (r) => normalizeName(r.name) === nameLc

    );

    if (byName) return byName.image || fallbackImage;



    // match by value tolerance

    if (!Number.isNaN(valueNum)) {

      const byValue = box.rewards.find(

        (r) => Math.abs((r.value || 0) - valueNum) < 1e-6

      );

      if (byValue) return byValue.image || fallbackImage;

    }



    return fallbackImage;

  }



  function triggerSpinAnimation(box, rewardName, rewardValue) {
    const fallbackImage = box.image || commonBox;
    const baseList = box.rewards.map((r) => ({
      name: r.name,
      image: r.image || fallbackImage,
    }));

    const items = [];
    const total = 32;
    const targetIndex = total - 6;

    for (let i = 0; i < total; i++) {
      const pick = baseList[i % baseList.length];
      items.push({ ...pick });
    }

    const targetImage = findRewardAsset(box, rewardName, rewardValue);
    const targetReward =
      baseList.find((r) => normalizeName(r.name) === normalizeName(rewardName)) ||
      baseList[0];
    items[targetIndex] = {
      name: rewardName || targetReward.name,
      image: targetImage,
    };

    const approxWidth = 182;
    const fallbackTranslate = Math.max(0, targetIndex * approxWidth - approxWidth * 2);

    setSpinState({
      open: true,
      items,
      targetIndex,
      translate: 0,
      animate: false,
      boxName: box.name,
      rewardName,
    });

    const alignSpin = () => {
      const track = spinTrackRef.current;
      const targetEl =
        track?.querySelector(`[data-spin-idx="${targetIndex}"]`) || null;
      if (track && targetEl) {
        const trackRect = track.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const offset = targetRect.left - trackRect.left;
        const translate = Math.max(
          0,
          offset - (trackRect.width - targetRect.width) / 2
        );
        setSpinState((prev) => ({
          ...prev,
          translate,
          animate: true,
        }));
        return;
      }
      setSpinState((prev) => ({
        ...prev,
        translate: fallbackTranslate,
        animate: true,
      }));
    };

    requestAnimationFrame(() => requestAnimationFrame(alignSpin));

    setTimeout(() => {
      setSpinState((prev) => ({ ...prev, open: false, animate: false }));
    }, SPIN_DURATION_MS + 600);
  }



  return (

    <div className="app-shell">

        <header className="top-bar">

          <div className="brand-group">

            

            <img src={logo} alt="Gacha Watches" className="brand-logo" />

            <div className="social-chips">

              <a

                className="chip chip-icon"

                href="https://x.com/gachawatches?s=21"

                target="_blank"

                rel="noreferrer"

              >

                <img src={twitterIcon} alt="Twitter" />

              </a>

              <a

                className="chip chip-icon"

                href="https://dexscreener.com/solana/whonypyjJDT6EQqUf5nUpT6gTGTN2hDaEVAwu85pump"

                target="_blank"

                rel="noreferrer"

              >

                <img src={dexscreenerIcon} alt="Dexscreener" />

              </a>

              <button
                className="chip"
                type="button"
                onClick={() => setShowAboutModal(true)}
              >
                About
              </button>

            </div>

          </div>



        <div className="nav-links">
          <button
            className={`nav-link ${activeTab === "cases" ? "active" : ""}`}
            onClick={() => setActiveTab("cases")}
          >        Cases
              </button>
          <button
            className={`nav-link ${activeTab === "inventory" ? "active" : ""}`}
            onClick={() => setActiveTab("inventory")}
          >        Inventory
              </button>
        </div>


        <div className="wallet-actions">

          {connected && publicKey && (

            <div className="balance-pill">

              Balance: {usdcBalance.toFixed(2)} USDC

            </div>

          )}

          <WalletMultiButton className="wallet-btn" />

        </div>

      </header>



      <main className="page-content">

        {message && <div className="notice">{message}</div>}



        {activeTab === "cases" && !selectedBox && (

          <section className="cases-section">

            <div className="section-head">
              <div>
                <p className="eyebrow">Drop Watches</p>
                <h1>Pick a case and drop a watch</h1>
                <p className="subhead">
                  All it takes is one click. Connect your wallet and open instantly.
                </p>
              </div>
              
            </div>


            <div className="cases-grid">

              {LOOTBOXES.map((box) => (

                <div

                  key={box.id}

                  className={`case-card ${box.colorClass}`}

                >

                  <div className="case-illus" onClick={() => setSelectedBox(box)}>

                    {box.image && (

                      <img src={box.image} alt={box.name} loading="lazy" />

                    )}

                  </div>

                  <div className="case-body">
                    <div className="case-title">{box.name}</div>
                    <div className="case-price">
                      {formatPriceLabel(box, quote)}
                    </div>
                    <div className="case-rewards">
                      {(box.rarityChances || []).map((r, idx) => (
                        <span key={idx} className="reward-pill">
                          {r.label} - {r.chance}
                        </span>
                      ))}

                    </div>

                    <div className="case-actions">

                      <button

                        className="secondary"

                        onClick={() => setSelectedBox(box)}

                      >        View case
              </button>

                      <button
                        className="secondary"
                        onClick={() => handleFreeTrial(box.id)}
                        disabled={loadingTrialId === box.id}
                      >
                        {loadingTrialId === box.id ? "Running" : "Free try"}
                      </button>

                      <button
                        className="case-button"
                        onClick={() => handleBuy(box.id)}
                        disabled={
                          !connected ||
                          !merchantWallet ||
                          loadingBoxId === box.id
                        }
                      >
                        {!connected
                          ? "Connect wallet"
                          : !merchantWallet
                          ? "Missing config"
                          : loadingBoxId === box.id
                          ? "Opening..."
                          : "Open case"}
                      </button>
                    </div>

                  </div>

                </div>

              ))}

            </div>



            {lastDrop && (

              <div className="drop-highlight">

                <div>

                  <p className="eyebrow">Last drop</p>

                  <strong>{lastDrop.boxName}</strong> -&gt; {lastDrop.rewardName} (

                  {lastDrop.rewardValue} USDC) at {lastDrop.timestamp}

                </div>

              </div>

            )}

          </section>

        )}



        {activeTab === "cases" && selectedBox && (

          <section className="case-detail">

            <div className="section-head detail-head">

              <button className="link-back" onClick={() => setSelectedBox(null)}>
                ← Back to cases
              </button>

              <div>
                <p className="eyebrow">Case detail</p>
                <h1>{selectedBox.name}</h1>
                <p className="subhead">
                  Price: {selectedBox.priceUsd} USD ({formatPriceLabel(selectedBox, quote)})
                </p>
              </div>
            </div>


            <div className="detail-spin">

              <div className="spin-track">

                <div className="spin-strip">

                  {selectedBox.rewards.map((reward, idx) => (

                    <div key={`${reward.name}-${idx}`} className="spin-item">

                      <div className={`spin-img ${getRarityClass(reward.name)}`}>

                        <img

                          src={reward.image || selectedBox.image}

                          alt={reward.name}

                          loading="lazy"

                        />

                      </div>

                      <div className="spin-name">{reward.name}</div>

                    </div>

                  ))}

                </div>

              </div>

              <div className="detail-actions">

                <button
                  className="secondary lg"
                  onClick={() => handleFreeTrial(selectedBox.id)}
                  disabled={loadingTrialId === selectedBox.id}
                >
                  {loadingTrialId === selectedBox.id ? "Running..." : "Free try"}
                </button>

                <button
                  className="primary lg"
                  onClick={() => handleBuy(selectedBox.id)}
                  disabled={
                    !connected ||
                    !merchantWallet ||
                    loadingBoxId === selectedBox.id
                  }
                >
                  {!connected
                    ? "Connect wallet"
                    : !merchantWallet
                    ? "Missing config"
                    : loadingBoxId === selectedBox.id
                    ? "Opening..."
                    : `Open for ${formatPriceLabel(selectedBox, quote)}`}
                </button>
              </div>
            </div>


            <div className="loot-grid">

              {[...selectedBox.rewards]

                .slice()

                .sort((a, b) => a.chance - b.chance || b.value - a.value)

                .map((reward, idx) => (

                  <div

                    key={`${reward.name}-${idx}`}

                    className={`loot-card ${getRarityClass(reward.name)}`}

                  >

                    <div className="loot-img">

                      <img

                        src={reward.image || selectedBox.image}

                        alt={reward.name}

                        loading="lazy"

                      />

                    </div>

                    <div className="loot-info">

                      <div className="loot-name">{reward.name}</div>

                      <div className="loot-meta">

                        <span>{reward.value} USDC</span>

                        <span>{formatChance(reward)}</span>

                      </div>

                    </div>

                  </div>

                ))}

            </div>

          </section>

        )}



        {activeTab === "inventory" && (
          <section className="inventory-section">
            <div className="section-head">
              <div>
                <p className="eyebrow">Your history</p>
                <h1>Inventory</h1>
                <p className="subhead">
                  All confirmed drops tied to your wallet.
                </p>
              </div>
            </div>

                        <div className="profile-form">
              <h3>Shipping information</h3>
              <p className="subhead">Save or edit your address before claiming.</p>
              <button className="profile-launch" onClick={openProfileModal}>
                Address
              </button>
            </div>

            {!API_BASE && (
              <div className="notice">
                Set VITE_API_BASE to load your inventory.
              </div>
            )}

            {API_BASE && loadingInventory && (

              <div className="notice">Loading inventory...</div>

            )}

            {API_BASE && !loadingInventory && inventory.length === 0 && (

              <div className="notice">No transactions for this wallet yet.</div>

            )}

            {API_BASE && inventory.length > 0 && (

              <div className="inventory-grid">

                {inventory.map((item, index) => (

                  <div

                    key={`${item.signature}-${index}`}

                    className={`inventory-card ${getRarityClass(

                      item.rewardName

                    )}`}

                  >

                    <div className="inventory-top">

                      <span className="tag">{item.boxName}</span>

                      <span className="inventory-value">

                        {item.rewardValue} USDC

                      </span>

                    </div>

                    <div className="inventory-row">

                      <div className={`inventory-thumb ${getRarityClass(

                        item.rewardName

                      )}`}>

                        <img

                          src={getRewardImage(item.boxId, item.rewardName)}

                          alt={item.rewardName}

                          loading="lazy"

                        />

                      </div>

                      <div className="inventory-info">

                        <div className="inventory-reward">{item.rewardName}</div>

                        <div className="inventory-meta">
                          {new Date(item.createdAt).toLocaleString()}
                        </div>
                        <div className="inventory-meta muted">
                          tx: {item.signature.slice(0, 6)}...
                        </div>
                        <div className="inventory-meta muted">
                          NFT:{" "}
                          {item.mint
                            ? "Minted"
                            : item.mintStatus === "failed"
                            ? "Failed - retry"
                            : "Pending"}
                        </div>
                        <div className="inventory-meta muted">
                          Status:{" "}
                          {item.claimStatus === "sent"
                            ? "Sent"
                            : item.claimStatus === "claimed"
                            ? "Claimed (awaiting shipment)"
                            : "Available"}
                        </div>
                        <div className="inventory-actions">
                          {!item.mint && (
                            <button
                              className="secondary"
                              onClick={() => handleMintRetry(item.id)}
                              disabled={mintRetryId === item.id}
                            >
                              {mintRetryId === item.id ? "Minting..." : "Retry mint"}
                            </button>
                          )}
                          {item.mint &&
                            item.claimStatus !== "claimed" &&
                            item.claimStatus !== "sent" && (
                            <button
                              className="secondary"
                              onClick={() => openClaimModal(item.id)}
                              disabled={loadingBoxId === `claim-${item.id}`}
                            >
                              Claim
                            </button>
                          )}
                          {item.claimStatus !== "claimed" && item.claimStatus !== "sent" && (
                            <button
                              className="case-button"
                              onClick={() => handleSellback(item.id, item.rewardValue)}
                              disabled={
                                loadingBoxId === `sell-${item.id}` || !item.mint
                              }
                            >
                              {loadingBoxId === `sell-${item.id}`
                                ? "Processing..."
                                : `Sell back (85%)`}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === "admin" && (
          <section className="cases-section">
            <div className="section-head">
              <div>
                <p className="eyebrow">Admin</p>
                <h1>Claims</h1>
                <p className="subhead">
                  Restricted area. Only wallets with claimed/sent drops are shown.
                </p>
              </div>
            </div>
            <div className="admin-panel">
              <div className="admin-row">
                <input
                  className="input"
                  type="password"
                  value={adminToken}
                  onChange={(e) => setAdminToken(e.target.value)}
                  placeholder="Admin token"
                />
                <button
                  className="secondary admbtn"
                  onClick={() => {
                    setAdminInventory([]);
                    setAdminError("");
                    setAdminWalletFilter("");
                  }}
                
                >
                  Clear
              </button>
              </div>
              <div className="admin-row">
                <input
                  className="input"
                  type="text"
                  value={adminWalletFilter}
                  onChange={(e) => setAdminWalletFilter(e.target.value)}
                  placeholder="Wallet filter (optional)"
                />
                <button
                  className="secondary admbtn"
                  onClick={() => fetchAdminInventoryByWallet(adminWalletFilter.trim())}
                  disabled={!adminToken || !adminWalletFilter.trim()}
                
                >
                  Search Wallet
              </button>
                <button
                  className="primary searchall"
                  onClick={() => fetchAdminInventoriesAll()}
                  disabled={!adminToken}
                
                >
                  Search all
              </button>
              </div>
              {adminError && <div className="notice">{adminError}</div>}
              {adminLoading && <div className="notice">Loading inventories...</div>}
              {!adminLoading && adminToken && adminInventory.length === 0 && (
                <div className="notice">No data loaded.</div>
              )}
              {!adminLoading && adminInventory.length > 0 && (
                <div className="inventory-grid">
                  {adminInventory.map((entry) => (
                    <div key={entry.wallet} className="inventory-card">
                      <div className="inventory-top">
                        <span className="tag">Wallet</span>
                        <span className="inventory-value">
                          {entry.wallet}
                        </span>
                      </div>
                      {(entry.name ||
                        entry.phone ||
                        entry.email ||
                        entry.address ||
                        entry.city ||
                        entry.state ||
                        entry.postalCode ||
                        entry.country) && (
                        <div className="inventory-meta">
                          <strong>Profile</strong>
                          <div>{entry.name}</div>
                          <div>{entry.phone}</div>
                          <div>{entry.email}</div>
                          <div>
                            {entry.address} {entry.number} {entry.complement}
                          </div>
                          <div>
                            {entry.district} {entry.city} {entry.state} {entry.postalCode}{" "}
                            {entry.country}
                          </div>
                        </div>
                      )}
                      {(entry.drops || []).map((drop, idx) => (
                        <div key={`${entry.wallet}-${idx}`} className="inventory-row">
                          <div className={`inventory-thumb ${getRarityClass(drop.rewardName)}`}>
                            <img
                              src={getRewardImage(drop.boxId, drop.rewardName)}
                              alt={drop.rewardName}
                              loading="lazy"
                            />
                          </div>
                          <div className="inventory-info">
                            <div className="inventory-reward">{drop.rewardName}</div>
                          <div className="inventory-meta">
                            {new Date(drop.createdAt).toLocaleString()}
                          </div>
                          <div className="inventory-meta muted">
                            {drop.rewardValue} USDC - tx: {drop.signature.slice(0, 6)}...
                          </div>
                          <div className="inventory-meta muted">
                            Status:{" "}
                            {drop.claimStatus === "sent"
                              ? "Sent"
                              : drop.claimStatus === "claimed"
                              ? "Claimed (awaiting shipment)"
                              : "Available"}
                          </div>
                          {drop.claimStatus === "claimed" && (
                            <div className="detail-actions">
                              <button className="primary sentbtn" onClick={() => markSent(drop.id)}>
                                Set as sent
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
                </div>
              )}
            </div>
          </section>
        )}
      {showDropModal && pendingDrop && (
        <div className="modal-layer" onClick={closeDropModal}>
          <div className="modal-card drop-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Your drop</h3>
              <button className="icon-btn" onClick={closeDropModal} aria-label="Close">
                x
              </button>
            </div>
            <div className="drop-modal-body">
              <div className="drop-modal-thumb">
                <img
                  src={pendingDrop.image || commonBox}
                  alt={pendingDrop.rewardName}
                  loading="lazy"
                />
              </div>
              <div className="drop-modal-info">
                <div className="loot-name">{pendingDrop.rewardName}</div>
                <div className="loot-meta">Case: {pendingDrop.boxName}</div>
                <div className="loot-meta">Value: {pendingDrop.rewardValue} USDC</div>
              </div>
            </div>
            <div className="detail-actions">
              <button className="secondary" onClick={closeDropModal}>
                Keep
              </button>
              <button
                className="primary sellbackbtn"
                disabled={
                  !pendingDrop.dropId ||
                  loadingBoxId === `sell-${pendingDrop.dropId}` ||
                  !pendingDrop.mint
                }
                onClick={() =>
                  pendingDrop.dropId &&
                  handleSellback(pendingDrop.dropId, pendingDrop.rewardValue)
                }
              >
                {loadingBoxId === `sell-${pendingDrop.dropId}` ? "Selling..." : "Sell back (85%)"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showTrialModal && trialDrop && (
        <div className="modal-layer" onClick={closeTrialModal}>
          <div className="modal-card drop-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Free try</h3>
              <button className="icon-btn" onClick={closeTrialModal} aria-label="Close">
                x
              </button>
            </div>
            <div className="drop-modal-body">
              <div className="drop-modal-thumb">
                <img
                  src={trialDrop.image || commonBox}
                  alt={trialDrop.rewardName}
                  loading="lazy"
                />
              </div>
              <div className="drop-modal-info">
                <div className="loot-name">{trialDrop.rewardName}</div>
                <div className="loot-meta">Case: {trialDrop.boxName}</div>
                <div className="loot-meta">Value: {trialDrop.rewardValue} USDC</div>
              </div>
            </div>
            <div className="detail-actions">
              <button className="primary secondary" onClick={closeTrialModal}>
                Ok
              </button>
            </div>
          </div>
        </div>
      )}
      {showAboutModal && (
        <div className="modal-layer" onClick={closeAboutModal}>
          <div className="modal-card drop-modal about-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>About Gacha Watches</h3>
              <button className="icon-btn" onClick={closeAboutModal} aria-label="Close">
                x
              </button>
            </div>
            <div className="drop-modal-body">
              <div className="drop-modal-info">
                <p>
                  Gacha Watches is a Web3-based collectible platform that merges luxury watches with
                  blockchain technology and gamified mechanics. Users purchase watch boxes using
                  USDC, and each box reveals a randomized watch NFT, inspired by real and collectible
                  timepieces.
                </p>
                <p>
                  Every watch obtained through Gacha Watches is a unique NFT, verifiable on the
                  blockchain and fully owned by the user. Once a watch is revealed, holders have
                  full control over their asset: they can claim the physical watch, keep the NFT as a
                  collectible, or sell it back to the platform for liquidity.
                </p>
                <p>
                  The project is designed around transparency, fairness, and excitement, bringing the
                  thrill of gacha-style openings into the world of high-value collectibles. Rarity
                  tiers, limited supplies, and provable randomness ensure a dynamic and engaging
                  experience for collectors and traders alike.
                </p>
                <p>
                  By combining crypto payments, NFTs, and real-world assets, Gacha Watches creates a
                  new way to collect, trade, and experience watches in the digital age.
                </p>
              </div>
            </div>
            <div className="detail-actions">
              <button className="primary lg" onClick={closeAboutModal}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
      {showProfileModal && (
        <div className="modal-layer" onClick={closeProfileModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{profileMode === "claim" ? "Confirm claim" : "Shipping information"}</h3>
              <button className="icon-btn" onClick={closeProfileModal} aria-label="Close">x</button>
            </div>
            <div className="profile-grid">
              <input
                className="input"
                placeholder="Full name"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Phone with country code (e.g., +1...)"
                value={profile.phone}
                onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Email"
                value={profile.email}
                onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Address (Street)"
                value={profile.address}
                onChange={(e) => setProfile((p) => ({ ...p, address: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Number"
                value={profile.number}
                onChange={(e) => setProfile((p) => ({ ...p, number: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Address line 2 (optional)"
                value={profile.complement}
                onChange={(e) => setProfile((p) => ({ ...p, complement: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Neighborhood / District"
                value={profile.district}
                onChange={(e) => setProfile((p) => ({ ...p, district: e.target.value }))}
              />
              <input
                className="input"
                placeholder="City"
                value={profile.city}
                onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value }))}
              />
              <input
                className="input"
                placeholder="State / Province / Region"
                value={profile.state}
                onChange={(e) => setProfile((p) => ({ ...p, state: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Postal code (ZIP)"
                value={profile.postalCode}
                onChange={(e) => setProfile((p) => ({ ...p, postalCode: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Country"
                value={profile.country}
                onChange={(e) => setProfile((p) => ({ ...p, country: e.target.value }))}
              />
            </div>
                        <div className="detail-actions">
              <button
                className="secondary"
                onClick={submitProfileModal}
                disabled={
                  profileLoading ||
                  (profileMode === "claim" && claimDropId && loadingBoxId === `claim-${claimDropId}`)
                }
              >
                {profileMode === "claim"
                  ? loadingBoxId === `claim-${claimDropId}`
                    ? "Processing..."
                    : "Claim"
                  : profileLoading
                  ? "Saving..."
                  : "Save data"}
              </button>
            </div>
            {profileMessage && <div className="notice2">{profileMessage}</div>}
          </div>
        </div>
       )}
      </main>
      {spinState.open && (
        <div className="spin-overlay">
          <div className="spin-window">
            <div className="spin-header">
              <div>

                <p className="eyebrow">Opening...</p>

                <h3>{spinState.boxName}</h3>

              </div>

              <div className="marker">?</div>

            </div>

            <div className="spin-track" ref={spinTrackRef}>

              <div

                className="spin-strip"

                style={{

                  transform: `translateX(-${spinState.translate}px)`,

                  transition: spinState.animate
                    ? `transform ${SPIN_DURATION_MS}ms cubic-bezier(0.12, 0.66, 0.12, 1)`
                    : "none",
                  willChange: "transform",

                }}

              >

                {spinState.items.map((item, idx) => (

                  <div
                    key={`${item.name}-${idx}`}
                    className="spin-item"
                    data-spin-idx={idx}
                  >

                    <div className={`spin-img ${getRarityClass(item.name)}`}>

                      <img src={item.image} alt={item.name} loading="lazy" />

                    </div>

                    <div className="spin-name">{item.name}</div>

                  </div>

                ))}

              </div>

            </div>

          </div>

        </div>

      )}
    </div>

  );

}



export default App;










