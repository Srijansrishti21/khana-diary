/* Khana Diary engine: the Python engine (text_log.py, my_recipes.py, suggest.py, compute.py)
 * ported to plain JavaScript so the app runs entirely on the phone, offline.
 * Works in the browser (window.KhanaEngine) and in Node (module.exports) for parity tests.
 * Keep behaviour identical to the Python files; test_engine.mjs checks them against each other.
 */
(function (root) {
  "use strict";

  // ---------- difflib (Ratcliff/Obershelp, same as Python's SequenceMatcher without junk) ----------
  function longestMatch(a, b, alo, ahi, blo, bhi, b2j) {
    let besti = alo, bestj = blo, bestsize = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  }
  function ratio(a, b) {
    if (!a.length && !b.length) return 1;
    const b2j = new Map();
    for (let j = 0; j < b.length; j++) { if (!b2j.has(b[j])) b2j.set(b[j], []); b2j.get(b[j]).push(j); }
    let matches = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longestMatch(a, b, alo, ahi, blo, bhi, b2j);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return 2 * matches / (a.length + b.length);
  }
  // Python: SequenceMatcher(seq1=candidate, seq2=word); best first, ties -> larger string first.
  function closeMatches(word, candidates, n, cutoff) {
    const out = [];
    for (const x of candidates) {
      const r = ratio(x, word);
      if (r >= cutoff) out.push([r, x]);
    }
    out.sort((p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
    return out.slice(0, n).map(p => p[1]);
  }

  const fmtG = x => String(parseFloat(Number(x).toPrecision(6)));
  const round2 = x => Math.round(x * 100) / 100;
  const titleCase = w => w.charAt(0).toUpperCase() + w.slice(1);

  // ---------- meal text (text_log.py) ----------
  const NUMBER_WORDS = { half: 0.5, aadha: 0.5, adha: 0.5, quarter: 0.25, paav: 0.25, a: 1, an: 1, one: 1, ek: 1, two: 2, do: 2,
    three: 3, teen: 3, four: 4, char: 4, chaar: 4, five: 5, paanch: 5, six: 6, chhe: 6 };
  const SIZE_WORDS = { small: "small", chhota: "small", chota: "small", mini: "small", medium: "medium", regular: "medium",
    normal: "medium", large: "large", big: "large", bada: "large", bade: "large", badi: "large" };
  const UNIT_WORDS = { katori: "katori", katoris: "katori", "katori's": "katori", bowl: "katori", bowls: "katori",
    plates: "plate", glasses: "glass", cups: "cup", plate: "plate", glass: "glass", cup: "cup", tsp: "tsp",
    teaspoon: "tsp", spoon: "tsp", chammach: "tsp", tbsp: "tbsp", tablespoon: "tbsp", piece: "piece", pieces: "piece",
    pcs: "piece", slice: "slice", pack: "pack", packet: "pack", chiplet: "pack", sachet: "pack",
    g: "g", gm: "g", gms: "g", gram: "g", grams: "g" };
  const PLATE_BY_DEFAULT = new Set(["pav_bhaji", "misal_pav", "chole_kulche", "veg_momos", "chicken_momos", "paneer_momos",
    "mutton_momos", "pork_momos", "fried_momos", "tandoori_momos"]);
  const FILLER_SIZE = new Set(["smallest", "biggest"]);
  const VARIANTS = {
    momos: ["Which momos: veg, chicken, paneer, mutton or pork? Steamed, fried or tandoori?",
      { veg: "veg_momos", chicken: "chicken_momos", paneer: "paneer_momos", mutton: "mutton_momos",
        pork: "pork_momos", fried: "fried_momos", tandoori: "tandoori_momos" }],
  };
  const BOOK_SERVING_G = [[/rice|khichdi|khichri|khitchdi|pulao|biryani|biriyani|upma|poha|pongal/i, 200, "plate"],
    [/dal|curry|sabzi|bhaji|kofta|korma|kadhi|sambar|rasam|raita|kheer|payasam/i, 150, "katori"]];
  const DESCRIBERS = new Set(["vegetable", "vegetables", "veg", "veggies", "mixed", "sabzi", "sabzian"]);
  const PIECE_IN_GRAVY_G = 60;
  const FILLER = new Set(["of", "with", "and", "ka", "ki", "ke", "wala", "wali", "some", "thoda", "thodi", "had", "ate",
    "khaya", "piya", "i", "for", "breakfast", "lunch", "dinner", "snack", "made", "homemade", "my"]);
  const NUTRIENT_KEYS = ["kcal", "protein_g", "carb_g", "fat_g", "fibre_g", "sugar_g", "satfat_g", "sodium_mg",
    "calcium_mg", "iron_mg", "potassium_mg", "vitc_mg", "folate_ug"];
  const MACROS = ["kcal", "protein_g", "fat_g", "carb_g", "fibre_g"];

  function createEngine(DATA) {
    // names: lowercase name -> [kind, id]; insertion order mirrors the Python dict
    const names = new Map();
    const setDefault = (k, v) => { if (!names.has(k)) names.set(k, v); };
    for (const [id, d] of Object.entries(DATA.dishes)) {
      names.set(d.dish.split("(")[0].trim().toLowerCase(), ["dish", id]);
      names.set(id.replace(/_/g, " "), ["dish", id]);
      for (const a of DATA.aliases[id] || []) names.set(a.toLowerCase(), ["dish", id]);
    }
    for (const [pid, p] of Object.entries(DATA.portions)) {
      if (p.kind === "plate") setDefault(p.label.toLowerCase().replace("1 plate ", ""), ["plate", pid]);
    }
    for (const [bid, b] of Object.entries(DATA.basics)) {
      for (const n of [b.name.split("(")[0].trim(), ...(b.aliases || [])]) names.set(n.toLowerCase(), ["basic", bid]);
    }
    const plateOf = {};
    for (const [plateId, items] of Object.entries(DATA.plates)) {
      if (DATA.portions[`plate:${plateId}`] && !(items[0] in plateOf)) plateOf[items[0]] = `plate:${plateId}`;
    }
    for (const [code, b] of Object.entries(DATA.book)) {
      const idx = b.dish.indexOf("(");
      const main = idx >= 0 ? b.dish.slice(0, idx) : b.dish;
      const inner = idx >= 0 ? b.dish.slice(idx + 1).replace(/\)+$/, "") : "";
      for (let n of [...main.split("/"), ...inner.split("/")]) {
        n = n.trim().toLowerCase();
        if (n.length > 2) setDefault(n, ["book", code]);
      }
    }
    const nameKeys = [...names.keys()];
    const vocab = [...new Set(nameKeys.flatMap(n => n.split(/\s+/).filter(w => w.length > 2)))].sort();
    const numberedNames = nameKeys.filter(n => /\d/.test(n)).sort((x, y) => y.length - x.length);

    function splitItems(text) {
      text = text.toLowerCase().replace(/\+/g, " and ").replace(/&/g, " and ");
      return text.split(/,|\band\b|\bwith\b|\baur\b|\bsath\b|\bsaath\b/).map(s => s.trim()).filter(Boolean);
    }
    function protectNumbered(chunk) {
      for (const n of numberedNames) {
        if (chunk.includes(n)) chunk = chunk.split(n).join(n.replace(/ /g, "§").replace(/6/g, "six").replace(/5/g, "five"));
      }
      return chunk;
    }
    function parseItem(chunk) {
      let qty = null, size = null, unit = null; const words = [];
      chunk = protectNumbered(chunk).replace(/½/g, " 1/2 ").replace(/¼/g, " 1/4 ").replace(/¾/g, " 3/4 ");
      chunk = chunk.replace(/\d+\s*%/g, " ");
      for (const tok of chunk.match(/\d+\/\d+|[\d.]+|[a-z§]+/g) || []) {
        if (tok in NUMBER_WORDS && qty !== null && NUMBER_WORDS[tok] === qty) continue;
        if (tok.includes("/")) { const [n, d] = tok.split("/"); qty = parseFloat(n) / parseFloat(d); }
        else if (/^[\d.]+$/.test(tok)) qty = parseFloat(tok);
        else if (tok in NUMBER_WORDS && qty === null) qty = NUMBER_WORDS[tok];
        else if (FILLER_SIZE.has(tok)) continue;
        else if (tok in SIZE_WORDS) size = SIZE_WORDS[tok];
        else if (tok in UNIT_WORDS) unit = UNIT_WORDS[tok];
        else if (!FILLER.has(tok)) words.push(tok);
      }
      const food = words.join(" ").replace(/§/g, " ").replace(/sixfive/g, "65");
      return [qty, size, unit, food];
    }
    function correctTokens(food) {
      return food.split(/\s+/).filter(Boolean).map(w => {
        if (!vocab.includes(w) && w.length > 3) {
          const close = closeMatches(w, vocab, 3, 0.72).filter(c => Math.abs(c.length - w.length) <= 2);
          return close.length ? close[0] : w;
        }
        return w;
      }).join(" ");
    }
    function match(food) {
      food = correctTokens(food);
      if (names.has(food)) return [names.get(food), 1.0];
      const best = closeMatches(food, nameKeys, 1, 0.6);
      const typed = new Set(food.split(/\s+/).filter(Boolean));
      if (best.length && typed.size > 1) {
        const bestWords = new Set(best[0].split(/\s+/));
        const subset = [...typed].every(w => bestWords.has(w));
        if (!subset && ratio(food, best[0]) < 0.85) return [null, 0];
      }
      if (best.length) {
        const r = ratio(food, best[0]);
        if (r < 0.75) return [null, 0];
        return [names.get(best[0]), r];
      }
      return [null, 0];
    }
    function suggestionsFor(food, n = 5) {
      const seen = new Set(), out = [];
      for (const name of closeMatches(food, nameKeys, 15, 0.45)) {
        const key = names.get(name).join("|");
        if (!seen.has(key)) { seen.add(key); out.push(name); }
        if (out.length === n) break;
      }
      return out;
    }
    function matchMine(food, mine) {
      const own = new Map();
      for (const [rid, r] of Object.entries(mine)) {
        for (const n of [r.name.toLowerCase(), ...(r.aliases || [])]) own.set(n, rid);
      }
      if (own.has(food)) return own.get(food);
      const best = closeMatches(food, [...own.keys()], 1, 0.82);
      return best.length ? own.get(best[0]) : null;
    }
    const pick = (row, mult) => {
      const out = {};
      for (const k of NUTRIENT_KEYS) if (row[k] != null && !Number.isNaN(row[k])) out[k] = round2(row[k] * mult);
      return out;
    };

    function analyze(text, mine = {}) {
      const items = [];
      for (let chunk of splitItems(text)) {
        let [qty, size, unit, food] = parseItem(chunk);
        const counted = qty !== null; qty = qty || 1;
        if (!food) continue;
        let item = { text: chunk, qty };
        const rid = matchMine(food, mine);
        if (rid) {
          const r = mine[rid];
          const [per, mult, desc] = unit === "g" && r.per_100g ? [r.per_100g, qty / 100, `g ${r.name} (my recipe)`]
            : [r.per_serving, qty, `${r.makes_unit} ${r.name} (my recipe)`];
          items.push({ ...item, status: "ok", kind: "mine", id: `mine:${rid}`, desc, confirm: false, matched_from: food,
            sizes: [], ask: null, nutrients: pick(per, mult) });
          continue;
        }
        const group = Object.keys(VARIANTS).find(g => food.includes(g) || g.includes(food.replace(/s+$/, "")));
        if (group) {
          const [question, choices] = VARIANTS[group];
          const picked = food.split(/\s+/).filter(w => w in choices).map(w => choices[w]);
          if (!picked.length) {
            items.push({ ...item, status: "ask", question,
              choices: Object.keys(choices).map(w => ({ label: titleCase(w), text: `${chunk} ${w}` })) });
            continue;
          }
          const last = picked[picked.length - 1];
          if (!DATA.dishes[last]) { items.push({ ...item, status: "missing", name: last.replace(/_/g, " ") }); continue; }
          food = last.replace(/_/g, " ");
        }
        let [hit, score] = match(food);
        const prev = items.length ? items[items.length - 1] : null;
        const describesPrev = food.split(/\s+/).every(w => DESCRIBERS.has(w));
        if ((!hit || describesPrev) && prev && prev.status === "ok") {
          const lead = describesPrev ? "vegetable" : food;
          const [combo, cscore] = match(`${lead} ${prev.matched_from}`);
          if (combo && combo[1] !== prev.id && combo[0] !== "basic") {
            items.pop();
            chunk = `${prev.text} with ${chunk}`; food = `${lead} ${prev.matched_from}`; hit = combo; score = cscore;
            qty = prev.qty; item = { text: chunk, qty: prev.qty };
          }
        }
        if (!hit) { items.push({ ...item, status: "unknown", suggestions: suggestionsFor(food) }); continue; }
        let [kind, key] = hit;
        let sizes = [], ask = null, row, desc;
        if (kind === "book") {
          const b = DATA.book[key];
          let [g, unitName] = (BOOK_SERVING_G.find(([re]) => re.test(b.dish)) || [null, null, null]).slice(1);
          if (unit === "katori" || unit === "plate" || g) {
            g = { katori: 150, plate: 200 }[unit] || g;
            unitName = unit || unitName;
            row = {}; for (const [k, v] of Object.entries(b.per100)) row[k] = v * g / 100;
          } else {
            row = b.serving; unitName = b.unit || "serving";
          }
          desc = `${unitName} ${b.dish} (recipe book)`;
        } else if (kind === "plate") {
          row = DATA.portions[key].n; desc = DATA.portions[key].label;
        } else if (kind === "basic") {
          const b = DATA.basics[key], units = Object.keys(b.units);
          const p = units.find(u => unit && u.startsWith(unit)) || units.find(u => size && u.includes(size)) || units[0];
          row = DATA.portions[`basic:${key}:${p}`].n; desc = `${p} ${b.name.toLowerCase()}`;
          sizes = units.map(u => ({ label: u, text: `${fmtG(qty)} ${u} ${b.name.split("(")[0].trim().toLowerCase()}`, active: u === p }));
        } else {
          const d = DATA.dishes[key], pid = `${key}:${size || "medium"}`;
          row = DATA.portions[pid] ? DATA.portions[pid].n : d.n;
          desc = DATA.portions[pid] ? `${size || "medium"} ${d.dish}` : `${d.serving.replace(/_/g, " ")} ${d.dish}`;
          if (DATA.portions[`${key}:medium`]) {
            ask = DATA.portions[`${key}:medium`].ask;
            const base = chunk.replace(/\b(small|medium|large|chhota|bada|bade|badi|big|mini)\b/g, "").trim();
            sizes = ["small", "medium", "large"].filter(sz => DATA.portions[`${key}:${sz}`]).map(sz => ({
              label: `${titleCase(sz)}: ${DATA.portions[`${key}:${sz}`].description}`, text: `${sz} ${base}`,
              active: sz === (size || "medium") }));
          }
          if (unit === "piece" && (d.serving === "katori" || d.serving === "small_katori") && d.category === "curry") {
            const frac = PIECE_IN_GRAVY_G / d.serving_g;
            desc = `piece with gravy of ${d.dish} (~${(qty * frac).toFixed(1)} ${d.serving.replace(/_/g, " ")})`;
            row = {}; for (const k of NUTRIENT_KEYS) if (d.n[k] != null) row[k] = d.n[k] * frac;
          }
          if (plateOf[key] && (unit === "plate" || (unit === null && !counted && PLATE_BY_DEFAULT.has(key)))) {
            row = DATA.portions[plateOf[key]].n; desc = DATA.portions[plateOf[key]].label; sizes = [];
            kind = "plate"; key = plateOf[key];
          }
        }
        items.push({ ...item, status: "ok", kind, id: key, desc, confirm: score < 0.85, matched_from: food, sizes,
          ask: typeof ask === "string" ? ask : null, nutrients: pick(row, qty) });
      }
      return items;
    }

    // ---------- My recipes (my_recipes.py + compute.py) ----------
    const KITCHEN_NAMES = DATA.kitchen.flatMap(item => item.names.map(n => [n, item])).sort((x, y) => y[0].length - x[0].length);
    const KITCHEN_MAP = new Map(KITCHEN_NAMES);
    const R_UNITS = { cups: ["cup", 1], cup: ["cup", 1], mug: ["cup", 1], katoris: ["ml", 150], katori: ["ml", 150],
      bowls: ["ml", 150], bowl: ["ml", 150], glasses: ["ml", 200], glass: ["ml", 200], tablespoons: ["tbsp", 1],
      tablespoon: ["tbsp", 1], "table spoon": ["tbsp", 1], tbsp: ["tbsp", 1], tbs: ["tbsp", 1], tblsp: ["tbsp", 1],
      tbl: ["tbsp", 1], "bada chammach": ["tbsp", 1], teaspoons: ["tsp", 1], teaspoon: ["tsp", 1],
      "tea spoon": ["tsp", 1], tsp: ["tsp", 1], ts: ["tsp", 1], chammach: ["tsp", 1], spoons: ["tsp", 1],
      spoon: ["tsp", 1], kgs: ["kg", 1], kg: ["kg", 1], kilo: ["kg", 1], grams: ["g", 1], gram: ["g", 1],
      gms: ["g", 1], gm: ["g", 1], g: ["g", 1], ml: ["ml", 1], litres: ["l", 1], litre: ["l", 1], liter: ["l", 1],
      ltr: ["l", 1], l: ["l", 1], pinch: ["g", 0.3], bunch: ["g", 150], handful: ["g", 30], mutthi: ["g", 30], inch: ["g", 10] };
    const R_UNIT_KEYS = Object.keys(R_UNITS).sort((x, y) => y.length - x.length);
    const QTY_WORDS = [["one and a half", 1.5], ["one and half", 1.5], ["two and a half", 2.5], ["one fourth", 0.25],
      ["one-fourth", 0.25], ["three fourth", 0.75], ["one third", 1 / 3], ["two third", 2 / 3], ["quarter", 0.25],
      ["half", 0.5], ["aadha", 0.5], ["adha", 0.5], ["dedh", 1.5], ["dhai", 2.5], ["sava", 1.25], ["paune", 0.75],
      ["one", 1], ["ek", 1], ["two", 2], ["do", 2], ["three", 3], ["teen", 3], ["four", 4], ["char", 4],
      ["five", 5], ["paanch", 5], ["six", 6], ["seven", 7], ["eight", 8], ["ten", 10]];
    const VAGUE = /\b(some|little|thoda|thodi|as needed|as required|to taste|for tempering|for tadka)\b/;
    const TYPICAL = { fat: [1, "tbsp"], spice: [0.5, "tsp"], salt: [1, "tsp"] };
    const FAT_CODES = /^T\d/;
    const SPICE_CODES = /^G5|^G0(1[0-9]|2[0-9]|3[0-3])$/;
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word boundary without lookbehind (older iPhone Safari lacks it): letters must not touch the unit.
    const unitRe = w => new RegExp(`(^|[^a-z])${esc(w)}(?![a-z])`);

    function findIngredient(text) {
      for (const [n, item] of KITCHEN_NAMES) if (new RegExp(`\\b${esc(n)}\\b`).test(text)) return [n, item];
      const words = text.match(/[a-z]+/g) || [];
      for (const k of [3, 2, 1]) {
        for (let i = 0; i + k <= words.length; i++) {
          const ph = words.slice(i, i + k).join(" ");
          const close = closeMatches(ph, [...KITCHEN_MAP.keys()], 1, 0.82);
          if (close.length) return [close[0], KITCHEN_MAP.get(close[0])];
        }
      }
      return null;
    }
    function defaultUnit(code) {
      if (FAT_CODES.test(code)) return ["tbsp", 1];
      if (code === "G528" || SPICE_CODES.test(code)) return ["tsp", 1];
      if (code === "K505") return ["cup", 1];
      return ["ml", 150];
    }
    function parseLine(line) {
      let text = " " + line.toLowerCase().trim() + " ";
      text = text.replace(/½/g, " 1/2 ").replace(/¼/g, " 1/4 ").replace(/¾/g, " 3/4 ").replace(/(\d)(st|nd|rd|th)\b/g, "$1");
      let note = null, qty = null;
      const m = text.match(/(\d+)\s*\/\s*(\d+)|(\d+(?:\.\d+)?)/);
      if (m) {
        qty = m[1] ? parseInt(m[1], 10) / parseInt(m[2], 10) : parseFloat(m[3]);
        text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
      } else {
        for (const [w, v] of QTY_WORDS) {
          const re = new RegExp(`\\b${esc(w)}\\b`);
          if (re.test(text)) { qty = v; text = text.replace(re, " "); break; }
        }
      }
      let unit = null;
      for (const w of R_UNIT_KEYS) {
        const re = unitRe(w);
        if (re.test(text)) { unit = R_UNITS[w]; text = text.replace(re, "$1 "); break; }
      }
      const hit = findIngredient(text);
      if (!hit) return [null, `don't know '${line.trim()}'`];
      const [name, item] = hit, code = item.code;
      const vague = VAGUE.test(text);
      if (qty === null && unit === null && !("each" in item)) {
        if (vague || FAT_CODES.test(code) || code === "G528" || SPICE_CODES.test(code)) {
          const kind = FAT_CODES.test(code) ? "fat" : code === "G528" ? "salt" : "spice";
          const [q, u] = TYPICAL[kind]; qty = q; unit = [u, 1];
          note = `'${line.trim()}': assumed ${fmtG(q)} ${u}`;
        } else {
          return [null, `how much ${name}? add an amount like '1 katori', '200 g' or '2 tbsp'`];
        }
      }
      qty = qty === null ? 1 : qty;
      const role = code === "K505" ? "water" : FAT_CODES.test(code) ? "cooking_fat" : "base";
      const ing = { text: line.trim(), code, role, amount: null, unit: null, grams: null };
      if (unit === null && "each" in item) { ing.unit = "nos"; ing.grams = item.each * qty; return [ing, note]; }
      if (unit === null) {
        const [u, mult] = defaultUnit(code);
        note = `'${line.trim()}': assumed ${fmtG(qty)} ${u === "ml" ? "katori" : u}`;
        unit = [u, mult];
      }
      ing.amount = qty * unit[1]; ing.unit = unit[0];
      return [ing, note];
    }
    const ML = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240, glass: 200 };
    function toGrams(ing) {
      if (ing.grams != null && ing.unit !== "g" && ing.unit !== "kg") return ing.grams;
      if (ing.unit === "g") return ing.amount;
      if (ing.unit === "kg") return ing.amount * 1000;
      const dens = (DATA.ingredients[ing.code] || {}).g_per_ml || 1;
      return ing.amount * ML[ing.unit] * dens;
    }
    function computeSource(ingredients) {
      const totals = {}; let added = 0, raw = 0;
      for (const ing of ingredients) {
        const g = toGrams(ing); raw += g;
        if (ing.role === "water") continue;
        const n = DATA.ingredients[ing.code].n;
        for (const [k, v] of Object.entries(n)) totals[k] = (totals[k] || 0) + v * g / 100;
        if (ing.role === "cooking_fat") added += (n.fat_g || 0) * g / 100;
      }
      return { totals, added, raw };
    }
    function calculateRecipe(name, lines, makesQty, makesUnit, cookedG) {
      const ingredients = [], problems = [], assumptions = [];
      for (const line of String(lines || "").split(/[\n,;]/).filter(l => l.trim())) {
        const [ing, msg] = parseLine(line);
        if (!ing) problems.push(msg); else { ingredients.push(ing); if (msg) assumptions.push(msg); }
      }
      if (!ingredients.length) return { error: "No ingredients recognised. Write one per line or comma, e.g. '1 cup toor dal'." };
      makesQty = parseFloat(makesQty) || 1;
      const res = computeSource(ingredients);
      const breakdown = ingredients.filter(i => i.role !== "water").map(i => {
        const one = computeSource([i]);
        return { line: i.text, matched: DATA.ingredients[i.code].name, grams: Math.round(one.raw), kcal: Math.round(one.totals.kcal || 0) };
      });
      const per = {}; for (const [k, v] of Object.entries(res.totals)) per[k] = round2(v / makesQty);
      const cooked = cookedG && +cookedG > 0 ? +cookedG : null;
      const per100 = cooked ? Object.fromEntries(Object.entries(res.totals).map(([k, v]) => [k, round2(v / cooked * 100)])) : null;
      return { name: String(name || "My recipe").trim(), makes_qty: makesQty, makes_unit: makesUnit,
        total_kcal: Math.round(res.totals.kcal || 0), per_serving: per,
        added_fat_g_per_serving: Math.round(res.added / makesQty * 10) / 10, breakdown, problems, assumptions,
        cooked_g: cooked, per_100g: per100, serving_g: cooked ? Math.round(cooked / makesQty) : null };
    }
    function recipeDiet(lines) {
      const codes = String(lines || "").split(/[\n,;]/).filter(l => l.trim()).map(l => parseLine(l)[0]).filter(Boolean).map(i => i.code);
      if (codes.some(c => "NOPQS".includes(c[0]))) return "nonveg";
      if (codes.some(c => c[0] === "M")) return "egg";
      return "veg";
    }

    // ---------- goal + suggestions (suggest.py) ----------
    const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 };
    const GOAL_DEFICIT = { lose: 500, lose_slow: 250, maintain: 0 };
    const MEAL_SHARE = { Breakfast: 0.25, Lunch: 0.35, Snack: 0.10, Dinner: 0.30 };
    const MEAL_ORDER = ["Breakfast", "Lunch", "Snack", "Dinner"];
    const MEAL_CAP = { Breakfast: 0.35, Lunch: 0.45, Snack: 0.15, Dinner: 0.45 };
    const BLOCKS = {
      egg_bhurji: ["egg", "main"], masala_omelette: ["egg", "main"], egg_curry: ["egg", "main"], boiled_egg_masala: ["egg", "main"],
      paneer_bhurji: ["veg", "main"], palak_paneer: ["veg", "main"], matar_paneer: ["veg", "main"], paneer_tikka: ["veg", "main"],
      kadai_paneer: ["veg", "main"], dal_tadka: ["veg", "main"], yellow_moong_dal: ["veg", "main"], masoor_dal: ["veg", "main"],
      dal_palak: ["veg", "main"], chana_dal: ["veg", "main"], rajma: ["veg", "main"], chole: ["veg", "main"],
      kala_chana_curry: ["veg", "main"], moong_sprouts_usal: ["veg", "main"], soya_chunks_curry: ["veg", "main"],
      besan_chilla: ["veg", "main"], moong_dal_chilla: ["veg", "main"], sambar: ["veg", "main"],
      poha: ["veg", "main"], upma: ["veg", "main"], vegetable_upma: ["veg", "main"],
      chicken_curry: ["nonveg", "main"], chicken_tikka: ["nonveg", "main"], tandoori_chicken: ["nonveg", "main"],
      fish_curry: ["nonveg", "main"], macher_jhol: ["nonveg", "main"], tawa_fish_fry: ["nonveg", "main"],
      keema_matar: ["nonveg", "main"], chicken_stew: ["nonveg", "main"],
      chapati: ["veg", "carb"], jowar_bhakri: ["veg", "carb"], bajra_roti: ["veg", "carb"], ragi_roti: ["veg", "carb"],
      steamed_rice: ["veg", "carb"], idli: ["veg", "carb"],
      kachumber_salad: ["veg", "side"], cucumber_raita: ["veg", "side"], bhindi_masala: ["veg", "side"],
      lauki_sabzi: ["veg", "side"], patta_gobi: ["veg", "side"], mix_veg_curry: ["veg", "side"],
      beans_poriyal: ["veg", "side"], tinda_sabzi: ["veg", "side"], cabbage_thoran: ["veg", "side"],
    };
    const DIET_ALLOWS = { veg: ["veg"], egg: ["veg", "egg"], nonveg: ["veg", "egg", "nonveg"] };
    const CARB_COUNTS = { chapati: [1, 2, 3], jowar_bhakri: [1, 2], bajra_roti: [1, 2], ragi_roti: [1, 2], steamed_rice: [0.5, 1], idli: [2, 3] };
    const MAIN_SCALES = [1, 1.5];
    const NO_CARB = new Set(["poha", "upma", "besan_chilla", "moong_dal_chilla", "paneer_tikka", "chicken_tikka", "tandoori_chicken", "tawa_fish_fry"]);
    const BREAKFAST_MAINS = new Set(["egg_bhurji", "masala_omelette", "basic:egg", "paneer_bhurji", "besan_chilla", "moong_dal_chilla",
      "moong_sprouts_usal", "sambar", "poha", "upma"]);
    const SNACK_MAINS = new Set(["basic:egg", "moong_sprouts_usal", "besan_chilla", "moong_dal_chilla", "paneer_tikka", "chicken_tikka"]);
    const LUNCH_DINNER_SKIP = new Set(["poha", "upma"]);
    const PAIRS = new Set(["egg_bhurji|chapati", "paneer_bhurji|chapati", "dal_tadka|steamed_rice", "rajma|steamed_rice",
      "chole|steamed_rice", "kadhi_pakora|steamed_rice", "sambar|idli", "sambar|steamed_rice", "palak_paneer|chapati",
      "matar_paneer|chapati", "chicken_curry|chapati", "chicken_curry|steamed_rice", "fish_curry|steamed_rice",
      "macher_jhol|steamed_rice", "egg_curry|chapati", "masala_omelette|chapati"]);
    const ONLY_WITH = { sambar: new Set(["steamed_rice", "idli"]), idli: new Set(["sambar"]) };

    function targets(p) {
      let calc;
      const w = parseFloat(p.weight_kg), h = parseFloat(p.height_cm), age = parseFloat(p.age);
      if ([w, h, age].every(x => !Number.isNaN(x))) {
        const bmr = 10 * w + 6.25 * h - 5 * age + (p.sex === "male" ? 5 : -161);
        const maintain = bmr * (ACTIVITY[p.activity || "light"] || 1.375);
        const floor = p.sex === "male" ? 1500 : 1200;
        const kcal = Math.max(floor, maintain - (GOAL_DEFICIT[p.goal || "lose"] ?? 500));
        calc = { maintenance_kcal: Math.round(maintain), kcal: Math.round(kcal / 50) * 50, protein_g: Math.min(Math.round(1.2 * w), 140) };
      } else {
        calc = { maintenance_kcal: null, kcal: 1800, protein_g: 90 };
      }
      if (p.kcal_override) calc.kcal = parseInt(p.kcal_override, 10);
      return { ...calc, diet: p.diet || "nonveg" };
    }
    function components(diet, mine) {
      const allowed = DIET_ALLOWS[diet], comps = [];
      for (const [id, [dDiet, role]] of Object.entries(BLOCKS)) {
        const d = DATA.dishes[id];
        if (!allowed.includes(dDiet) || !d) continue;
        const row = DATA.portions[`${id}:medium`] ? DATA.portions[`${id}:medium`].n : d.n;
        const name = d.dish.split("(")[0].split("/")[0].trim().toLowerCase();
        if (role === "carb") {
          for (const n of CARB_COUNTS[id] || [1]) {
            const unit = d.serving === "katori" ? "katori " : "";
            comps.push([id, "carb", `${fmtG(n)} ${unit}${name}`, row, n]);
          }
        } else if (role === "main") {
          for (const sc of d.serving !== "piece" ? MAIN_SCALES : [1, 2]) {
            const unit = d.serving !== "piece" ? d.serving.replace(/_/g, " ") + " " : "";
            comps.push([id, "main", `${fmtG(sc)} ${unit}${name}`, row, sc]);
          }
        } else {
          comps.push([id, "side", `1 ${d.serving.replace(/_/g, " ")} ${name}`, row, 1]);
        }
      }
      for (const [rid, r] of Object.entries(mine)) {
        if (!allowed.includes(recipeDiet(r.lines))) continue;
        comps.push([`mine:${rid}`, "main", `1 ${r.makes_unit} ${r.name} (your recipe)`, r.per_serving, 1]);
      }
      if (allowed.includes("egg")) comps.push(["basic:egg", "main", "2 boiled eggs", { kcal: 135, protein_g: 13.3, fat_g: 9.2, carb_g: 0, fibre_g: 0 }, 1]);
      comps.push(["basic:curd", "side", "1 small katori curd", { kcal: 79, protein_g: 5.7, fat_g: 3, carb_g: 7.8, fibre_g: 0 }, 1]);
      return comps;
    }
    function nextMeal(eatenMeals, hour) {
      if (hour < 4) return ["Snack", ["Snack"]];
      const byTime = hour < 11 ? "Breakfast" : hour < 16 ? "Lunch" : hour < 18 ? "Snack" : "Dinner";
      const later = MEAL_ORDER.slice(MEAL_ORDER.indexOf(byTime)).filter(m => !eatenMeals.has(m) || m === "Snack");
      return later.length ? [later[0], later] : ["Dinner", ["Dinner"]];
    }
    function suggest(dayEntries, profile, hour, meal = null, mine = {}, n = 5) {
      const t = targets(profile);
      const eaten = Object.fromEntries(MACROS.map(k => [k, 0]));
      const eatenIds = new Set();
      for (const e of dayEntries) for (const i of e.items) {
        for (const k of MACROS) eaten[k] += (i.nutrients || {})[k] || 0;
        eatenIds.add(i.id);
      }
      const leftKcal = t.kcal - eaten.kcal;
      const proteinGap = Math.max(0, t.protein_g - eaten.protein_g);
      const eatenMeals = new Set(dayEntries.map(e => e.meal));
      let remaining;
      if (meal) remaining = MEAL_ORDER.filter(m => !eatenMeals.has(m) || m === meal);
      else [meal, remaining] = nextMeal(eatenMeals, hour);
      if (!remaining.includes(meal)) remaining.push(meal);
      const share = MEAL_SHARE[meal] / remaining.reduce((s, m) => s + MEAL_SHARE[m], 0);
      const budget = leftKcal > 0 ? Math.min(leftKcal * share, t.kcal * MEAL_CAP[meal]) : 0;
      const result = { meal, targets: t, eaten_kcal: Math.round(eaten.kcal), left_kcal: Math.round(leftKcal),
        protein_gap_g: Math.round(proteinGap), budget_kcal: Math.round(budget), options: [], tips: [] };
      if (budget < 120) {
        result.tips.push("You're at or near today's goal. If you're hungry: a bowl of cucumber raita, kachumber salad, clear soup or buttermilk (all under 100 kcal).");
        return result;
      }
      const comps = components(t.diet, mine);
      const fitsMeal = id => id.startsWith("mine:") ? true : meal === "Breakfast" ? BREAKFAST_MAINS.has(id)
        : meal === "Snack" ? SNACK_MAINS.has(id) : !LUNCH_DINNER_SKIP.has(id);
      const mains = comps.filter(c => c[1] === "main" && fitsMeal(c[0]));
      const carbs = [null, ...comps.filter(c => c[1] === "carb")];
      const sides = [null, ...comps.filter(c => c[1] === "side")];
      const mealProteinNeed = proteinGap * share * 1.3;
      const scored = [];
      for (const main of mains) for (const carb of carbs) for (const side of sides) {
        if (meal === "Snack" && (carb || side)) continue;
        if (carb && (NO_CARB.has(main[0]) || (ONLY_WITH[carb[0]] && !ONLY_WITH[carb[0]].has(main[0]))
          || (ONLY_WITH[main[0]] && !ONLY_WITH[main[0]].has(carb[0])))) continue;
        if (!carb && ONLY_WITH[main[0]]) continue;
        const parts = [main, carb, side].filter(Boolean);
        const tot = Object.fromEntries(MACROS.map(k => [k, parts.reduce((s, c) => s + (c[3][k] || 0) * c[4], 0)]));
        if (tot.kcal > budget * 1.1 || tot.kcal < budget * 0.55) continue;
        const fit = 1 - Math.abs(tot.kcal - budget * 0.92) / budget;
        const proteinScore = Math.min(tot.protein_g, mealProteinNeed) / Math.max(mealProteinNeed, 1);
        const fullness = (tot.protein_g * 4 + tot.fibre_g * 8) / Math.max(tot.kcal, 1);
        const repeat = parts.filter(c => eatenIds.has(c[0])).length;
        const own = parts.some(c => c[0].startsWith("mine:"));
        const paired = !!carb && PAIRS.has(`${main[0]}|${carb[0]}`);
        scored.push([2 * fit + 1.5 * proteinScore + 2 * fullness - repeat + (own ? 0.6 : 0) + (paired ? 0.4 : 0), parts, tot]);
      }
      scored.sort((x, y) => y[0] - x[0]);
      const usedMains = new Set(), sideUses = {};
      for (const [, parts, tot] of scored) {
        const last = parts[parts.length - 1];
        const side = parts.length > 1 && last[1] === "side" ? last[0] : null;
        if (usedMains.has(parts[0][0]) || (side && (sideUses[side] || 0) >= 1)) continue;
        usedMains.add(parts[0][0]);
        if (side) sideUses[side] = (sideUses[side] || 0) + 1;
        const why = [`${Math.round(tot.kcal)} of your ${Math.round(budget)} kcal for ${meal.toLowerCase()}`];
        if (proteinGap > 5) why.push(`${Math.round(tot.protein_g)} g protein toward the ${Math.round(proteinGap)} g you still need`);
        if (parts.some(c => c[0].startsWith("mine:"))) why.push("uses your own recipe");
        result.options.push({ text: parts.map(c => c[2]).join(" + "),
          log_text: parts.map(c => c[2].replace(" (your recipe)", "")).join(", "),
          kcal: Math.round(tot.kcal), protein_g: Math.round(tot.protein_g * 10) / 10, carb_g: Math.round(tot.carb_g),
          fat_g: Math.round(tot.fat_g * 10) / 10, why: why.join("; ") });
        if (result.options.length === n) break;
      }
      if (proteinGap > 30) result.tips.push(`You're ${Math.round(proteinGap)} g short on protein today, so the options above lean on dal, paneer, eggs or chicken. Protein keeps you full for longer.`);
      if (meal === "Dinner" && hour >= 21) result.tips.push("It's late: a lighter dinner (no rice, one roti) sits better and helps sleep.");
      result.tips.push("Eat the salad or sabzi first and the roti/rice last: it blunts the sugar spike.");
      return result;
    }

    return { analyze, calculateRecipe, recipeDiet, targets, suggest, counts: {
      dishes: Object.keys(DATA.dishes).length, portions: Object.keys(DATA.portions).length,
      basics: Object.keys(DATA.basics).length, names: names.size, version: DATA.version } };
  }

  const api = { createEngine, ratio, closeMatches };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KhanaEngine = api;
})(typeof self !== "undefined" ? self : this);
