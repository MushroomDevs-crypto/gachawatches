import json
import re
import unicodedata
from pathlib import Path

def normalize(text: str) -> str:
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^A-Za-z0-9]+", " ", text).strip().lower()
    return text


def parse_price_lines(raw: str) -> dict[str, float]:
    prices: dict[str, float] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.lower() in {"uncommon", "rares", "epics", "legendaries"}:
            continue
        # drop leading index "1."
        line = re.sub(r"^\d+\.\s*", "", line)
        line = line.replace("US$", "$").replace("us$", "$").replace("~", "")
        # split by last '$'
        if "$" not in line:
            continue
        name_part, amount_part = line.rsplit("$", 1)
        name_part = name_part.replace("—", " ").replace("-", " ")
        # remove trailing currency markers
        name = name_part.strip(" -–—\u2013\u2014")
        try:
            value = float(re.sub(r"[^0-9.]", "", amount_part))
        except ValueError:
            continue
        prices[normalize(name)] = value
    return prices


def main() -> None:
    price_text = Path("price_data.txt").read_text(encoding="utf-8")
    prices = parse_price_lines(price_text)
    base = Path("src/assets/box2")
    assets = []
    for rar in ["uncommon", "rares", "epics", "legendaries"]:
        for p in (list((base / rar).glob("*.png")) + list((base / rar).glob("*.jpg")) + list((base / rar).glob("*.jpeg"))):
            assets.append(p.stem)
    asset_norm = {a: normalize(a) for a in assets}
    # build final mapping using fuzzy match for anything not directly mapped
    token_prices = {k: set(k.split()) for k in prices}
    final = {}
    for asset, norm in asset_norm.items():
        if norm in prices:
            final[asset] = prices[norm]
            continue
        # fuzzy match by token overlap
        best = None
        best_score = 0
        aset = set(norm.split())
        for pname, ptokens in token_prices.items():
            if not ptokens:
                continue
            score = len(aset & ptokens) / len(ptokens)
            if score > best_score:
                best_score = score
                best = pname
        if best and best_score >= 0.5:
            final[asset] = prices[best]
        else:
            final[asset] = None

    missing_final = [k for k, v in final.items() if v is None]
    print("prices parsed:", len(prices))
    print("assets:", len(assets))
    print("missing after fuzzy:", len(missing_final))
    if missing_final:
        print("Missing final list:")
        for m in missing_final:
            print("  -", m)

    Path("src/box2Prices.json").write_text(
        json.dumps(final, indent=2, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
