(function () {
  const PAGE_SIZE = 10;
  const SETTINGS_KEY = "spell-settings-v1";
  const OLD_MISTAKES_KEY = "gaokao-spell-mistakes-v1";
  const letters = "abcdefghijklmnopqrstuvwxyz";

  function isChunk(mode) {
    return mode === "root" || mode === "sound";
  }

  function catalog() {
    const bank = window.WORD_BANK || {};
    if (Array.isArray(bank.lists) && bank.lists.length) return bank.lists;
    return [{ id: "senior", name: "高中", words: bank.words || [] }];
  }

  function normalize(item) {
    const chunk = isChunk(item.mode) && item.parts && item.parts.length > 1;
    return {
      word: item.w,
      phonetic: item.p || "",
      pos: item.pos || "",
      meaning: item.m || item.g || "",
      gloss: item.g || item.m || "",
      mode: chunk ? item.mode : "letter",
      parts: chunk ? item.parts.slice() : item.w.split(""),
    };
  }

  function readJson(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      return raw && typeof raw === "object" ? raw : null;
    } catch (error) {
      return null;
    }
  }

  function defaultSettings() {
    return { matchWidth: true, slotHint: "count", useSqlite: false, seconds: 25 };
  }

  function loadSettings() {
    const saved = readJson(SETTINGS_KEY) || {};
    const settings = defaultSettings();
    if (typeof saved.matchWidth === "boolean") settings.matchWidth = saved.matchWidth;
    if (saved.slotHint === "line" || saved.slotHint === "count") settings.slotHint = saved.slotHint;
    if (typeof saved.useSqlite === "boolean") settings.useSqlite = saved.useSqlite;
    const seconds = Number(saved.seconds);
    if (seconds >= 5 && seconds <= 180) settings.seconds = Math.round(seconds);
    return settings;
  }

  const lists = catalog();
  const els = {
    listName: document.getElementById("list-name"),
    wordList: document.getElementById("word-list"),
    score: document.getElementById("score"),
    streak: document.getElementById("streak"),
    mistakeCount: document.getElementById("mistake-count"),
    range: document.getElementById("range"),
    openBook: document.getElementById("open-book"),
    openSettings: document.getElementById("open-settings"),
    modePill: document.getElementById("mode-pill"),
    roundLabel: document.getElementById("round-label"),
    clock: document.getElementById("clock"),
    timer: document.querySelector(".timer"),
    timerBar: document.getElementById("timer-bar"),
    play: document.getElementById("play"),
    clue: document.getElementById("clue"),
    slots: document.getElementById("slots"),
    hint: document.getElementById("hint"),
    pool: document.getElementById("pool"),
    undo: document.getElementById("undo"),
    clear: document.getElementById("clear"),
    result: document.getElementById("result"),
    resultKicker: document.getElementById("result-kicker"),
    resultWord: document.getElementById("result-word"),
    resultPhonetic: document.getElementById("result-phonetic"),
    resultPos: document.getElementById("result-pos"),
    resultMeaning: document.getElementById("result-meaning"),
    resultParts: document.getElementById("result-parts"),
    resultActions: document.getElementById("result-actions"),
    nextRound: document.getElementById("next-round"),
    failBook: document.getElementById("fail-book"),
    empty: document.getElementById("empty"),
    last: document.getElementById("last"),
    book: document.getElementById("book"),
    bookWhere: document.getElementById("book-where"),
    bookLetter: document.getElementById("book-letter"),
    bookPageLabel: document.getElementById("book-page-label"),
    bookList: document.getElementById("book-list"),
    bookPrev: document.getElementById("book-prev"),
    bookNext: document.getElementById("book-next"),
    practice: document.getElementById("practice-mistakes"),
    clearMistakes: document.getElementById("clear-mistakes"),
    settingsDialog: document.getElementById("settings"),
    optWidth: document.getElementById("opt-width"),
    optSqlite: document.getElementById("opt-sqlite"),
    optSeconds: document.getElementById("opt-seconds"),
    sqliteNote: document.getElementById("sqlite-note"),
  };

  let settings = loadSettings();
  let listId = lists[0].id;
  let bank = [];
  let rootPool = [];
  let soundPool = [];
  let mistakes = {};
  let mistakeWords = new Set();
  let sqliteOnline = false;
  let filter = "all";
  let deck = [];
  let deckIndex = 0;
  let roundNo = 0;
  let score = 0;
  let streak = 0;
  let phase = "play";
  let round = null;
  let timerId = null;
  let successId = null;
  let duration = settings.seconds * 1000;
  let endsAt = 0;
  let lastSolved = null;
  let bookPage = 1;
  let bookToken = 0;

  function localKey() {
    return "spell-mistakes-v2:" + listId;
  }

  function loadLocal() {
    const key = localKey();
    let data = readJson(key);
    if (!data && listId === "senior") {
      const old = readJson(OLD_MISTAKES_KEY);
      data = old || {};
      if (old) localStorage.setItem(key, JSON.stringify(old));
    }
    return data || {};
  }

  function saveLocal() {
    try {
      localStorage.setItem(localKey(), JSON.stringify(mistakes));
    } catch (error) {
      /* Private mode can block storage; the round still ends on screen. */
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function useSqlite() {
    return settings.useSqlite && sqliteOnline;
  }

  function shuffle(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function prepareList(id) {
    const list = lists.find(function (item) { return item.id === id; }) || lists[0];
    listId = list.id;
    els.listName.textContent = list.name;
    els.wordList.value = list.id;
    bank = (list.words || []).map(normalize).filter(function (entry) {
      return entry.word.replace(/[^a-z]/g, "").length > 3;
    });
    rootPool = [];
    soundPool = [];
    bank.forEach(function (entry) {
      const pool = entry.mode === "root" ? rootPool : entry.mode === "sound" ? soundPool : null;
      if (!pool) return;
      entry.parts.forEach(function (part) {
        if (pool.indexOf(part) === -1) pool.push(part);
      });
    });
  }

  function fillSelect(select, options) {
    select.replaceChildren();
    options.forEach(function (pair) {
      const option = document.createElement("option");
      option.value = pair[0];
      option.textContent = pair[1];
      select.appendChild(option);
    });
  }

  function fillLists() {
    fillSelect(els.wordList, lists.map(function (list) {
      return [list.id, list.name];
    }));
  }

  function fillRange() {
    const options = [
      ["all", "全部单词"],
      ["root", "只练词根"],
      ["sound", "只练发音"],
      ["letter", "只练字母"],
      ["mistakes", "只练错词"],
    ];
    letters.split("").forEach(function (letter) {
      options.push([letter, "字母 " + letter.toUpperCase()]);
    });
    fillSelect(els.range, options);
  }

  function fillBookLetters() {
    const options = [["all", "全部"]];
    letters.split("").forEach(function (letter) {
      options.push([letter, letter.toUpperCase()]);
    });
    fillSelect(els.bookLetter, options);
  }

  async function probeSqlite() {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      sqliteOnline = response.ok;
    } catch (error) {
      sqliteOnline = false;
    }
    updateSqliteNote();
  }

  function updateSqliteNote() {
    if (!settings.useSqlite) {
      els.sqliteNote.textContent = "当前错词存在这台浏览器。词很多时，打开错词本会一次读出全部记录。";
      return;
    }
    els.sqliteNote.textContent = sqliteOnline
      ? "已连上本地服务，错词写入 data/mistakes.sqlite。"
      : "还没连上 SQLite。请在项目目录运行 python3 server.py，再用 http://127.0.0.1:8080/ 打开。在此之前仍暂存在浏览器里。";
  }

  async function syncMistakeIndex() {
    if (useSqlite()) {
      const response = await fetch("/api/mistakes/keys?list=" + encodeURIComponent(listId), { cache: "no-store" });
      const data = await response.json();
      mistakeWords = new Set(data.words || []);
      mistakes = {};
    } else {
      mistakes = loadLocal();
      mistakeWords = new Set(Object.keys(mistakes));
    }
    els.mistakeCount.textContent = String(mistakeWords.size);
    els.bookWhere.textContent = useSqlite() ? "保存在 SQLite" : "保存在这台浏览器";
  }

  async function remember(entry) {
    const record = {
      list: listId,
      word: entry.word,
      phonetic: entry.phonetic,
      pos: entry.pos,
      meaning: entry.meaning,
      gloss: entry.gloss,
      at: Date.now(),
    };
    if (useSqlite()) {
      const response = await fetch("/api/mistakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) throw new Error("save failed");
      mistakeWords.add(entry.word);
    } else {
      const prev = mistakes[entry.word] || { count: 0 };
      mistakes[entry.word] = {
        word: entry.word,
        phonetic: entry.phonetic,
        pos: entry.pos,
        meaning: entry.meaning,
        gloss: entry.gloss,
        count: prev.count + 1,
        at: record.at,
      };
      mistakeWords.add(entry.word);
      saveLocal();
    }
    els.mistakeCount.textContent = String(mistakeWords.size);
  }

  function buildDeck() {
    let list = bank;
    if (filter === "root") list = bank.filter(function (entry) { return entry.mode === "root"; });
    else if (filter === "sound") list = bank.filter(function (entry) { return entry.mode === "sound"; });
    else if (filter === "letter") list = bank.filter(function (entry) { return entry.mode === "letter"; });
    else if (filter === "mistakes") list = bank.filter(function (entry) { return mistakeWords.has(entry.word); });
    else if (/^[a-z]$/.test(filter)) list = bank.filter(function (entry) { return entry.word.charAt(0) === filter; });
    deck = shuffle(list);
    deckIndex = 0;
  }

  function nextEntry() {
    if (!deck.length) return null;
    if (deckIndex >= deck.length) {
      deck = shuffle(deck);
      deckIndex = 0;
    }
    const entry = deck[deckIndex];
    deckIndex += 1;
    return entry;
  }

  function distractors(entry) {
    const needed = {};
    entry.parts.forEach(function (part) { needed[part] = true; });
    const chosen = [];
    if (isChunk(entry.mode)) {
      const source = entry.mode === "sound" ? soundPool : rootPool;
      const pool = shuffle(source.filter(function (part) { return !needed[part]; }));
      for (let i = 0; i < pool.length && chosen.length < 2; i += 1) chosen.push(pool[i]);
    } else {
      const bag = shuffle(letters.split(""));
      for (let i = 0; i < bag.length && chosen.length < 2; i += 1) chosen.push(bag[i]);
    }
    return chosen;
  }

  function clearTimers() {
    if (timerId) clearInterval(timerId);
    if (successId) clearTimeout(successId);
    timerId = null;
    successId = null;
  }

  function labelOf(text) {
    if (text === " ") return "空格";
    if (text === "-") return "-";
    return text;
  }

  function countMode() {
    return settings.slotHint !== "line";
  }

  function startRound() {
    clearTimers();
    const entry = nextEntry();
    if (!entry) {
      phase = "empty";
      round = null;
      render();
      return;
    }
    roundNo += 1;
    const tiles = entry.parts.map(function (text, index) {
      return { id: "c" + index + "-" + roundNo, text: text, used: false };
    });
    distractors(entry).forEach(function (text, index) {
      tiles.push({ id: "d" + index + "-" + roundNo, text: text, used: false });
    });
    round = { entry: entry, tiles: shuffle(tiles), picked: [] };
    phase = "play";
    duration = settings.seconds * 1000;
    endsAt = Date.now() + duration;
    timerId = setInterval(tick, 200);
    render();
    tick();
  }

  function tick() {
    if (phase !== "play" || !round) return;
    const left = endsAt - Date.now();
    const ratio = Math.max(0, left / duration);
    els.timerBar.style.transform = "scaleX(" + ratio + ")";
    els.clock.textContent = Math.max(0, Math.ceil(left / 1000)) + " 秒";
    els.timer.classList.toggle("low", left < 5000);
    if (left <= 0) failRound();
  }

  function pickedText() {
    return round.picked.map(function (tile) { return tile.text; }).join("");
  }

  function takeTile(id) {
    if (phase !== "play" || !round) return;
    if (countMode() && round.picked.length >= round.entry.parts.length) return;
    const tile = round.tiles.find(function (item) { return item.id === id; });
    if (!tile || tile.used) return;
    tile.used = true;
    round.picked.push(tile);
    if (pickedText() === round.entry.word) {
      succeed();
      return;
    }
    renderPicks();
  }

  function removeAt(index) {
    if (phase !== "play" || !round) return;
    const removed = round.picked.splice(index, 1)[0];
    if (removed) removed.used = false;
    renderPicks();
  }

  function undo() {
    if (phase !== "play" || !round || !round.picked.length) return;
    removeAt(round.picked.length - 1);
  }

  function clearPicks() {
    if (phase !== "play" || !round) return;
    round.picked.forEach(function (tile) { tile.used = false; });
    round.picked = [];
    renderPicks();
  }

  function succeed() {
    phase = "success";
    clearTimers();
    score += 1;
    streak += 1;
    lastSolved = round.entry;
    render();
    successId = setTimeout(startRound, 1000);
  }

  function failRound() {
    if (phase !== "play" || !round) return;
    phase = "fail";
    clearTimers();
    streak = 0;
    remember(round.entry).catch(function () {
      els.hint.textContent = "错词没写进去，请检查 SQLite 服务。";
    });
    render();
  }

  function showResult(entry, failed) {
    els.play.hidden = true;
    els.empty.hidden = true;
    els.result.hidden = false;
    els.result.classList.toggle("fail", failed);
    els.resultKicker.textContent = failed ? "本回合结束" : "组对了";
    els.resultWord.textContent = entry.word;
    els.resultPhonetic.hidden = !failed || !entry.phonetic;
    els.resultPhonetic.textContent = entry.phonetic;
    els.resultPos.textContent = entry.pos ? "词性 " + entry.pos : "词性 见释义";
    els.resultMeaning.textContent = entry.meaning || entry.gloss;
    if (failed && isChunk(entry.mode)) {
      els.resultParts.hidden = false;
      const label = entry.mode === "sound" ? "发音 " : "词根 ";
      els.resultParts.textContent = label + entry.parts.join(" + ");
    } else {
      els.resultParts.hidden = true;
    }
    els.resultActions.hidden = !failed;
  }

  function renderPicks() {
    const entry = round.entry;
    const line = !countMode();
    els.slots.classList.toggle("line", line);
    els.slots.replaceChildren();
    if (line) {
      const bar = document.createElement("div");
      bar.className = "answer-line";
      if (!round.picked.length) {
        bar.classList.add("empty");
        bar.textContent = "点选下面组成单词";
      } else {
        round.picked.forEach(function (tile, index) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "line-chip";
          chip.textContent = labelOf(tile.text);
          chip.addEventListener("click", function () { removeAt(index); });
          bar.appendChild(chip);
        });
      }
      els.slots.appendChild(bar);
      els.hint.textContent = pickedText().length > entry.word.length ? "长了，点已选的部分或撤回。" : "";
    } else {
      entry.parts.forEach(function (part, index) {
        const picked = round.picked[index];
        const slot = document.createElement(picked ? "button" : "div");
        slot.className = "slot" + (picked ? " filled" : "");
        if (settings.matchWidth) {
          slot.style.minWidth = Math.max(48, labelOf(part).length * 18 + 24) + "px";
        }
        if (picked) {
          slot.type = "button";
          slot.textContent = labelOf(picked.text);
          slot.addEventListener("click", function () { removeAt(index); });
        } else {
          slot.setAttribute("aria-hidden", "true");
        }
        els.slots.appendChild(slot);
      });
      const full = round.picked.length === entry.parts.length;
      els.hint.textContent = full && pickedText() !== entry.word ? "这组还不是这个词，点已选的块可以拿下来。" : "";
    }

    const full = countMode() && round.picked.length === entry.parts.length;
    els.pool.querySelectorAll(".tile").forEach(function (button) {
      const tile = round.tiles.find(function (item) { return item.id === button.dataset.id; });
      button.disabled = !tile || tile.used || (full && tile && !tile.used);
    });
  }

  function renderPlay() {
    const entry = round.entry;
    els.play.hidden = false;
    els.result.hidden = true;
    els.empty.hidden = true;
    els.modePill.textContent = entry.mode === "root" ? "选词根" : entry.mode === "sound" ? "按发音" : "选字母";
    els.roundLabel.textContent = "第 " + roundNo + " 题";
    els.clue.textContent = entry.meaning || entry.gloss;
    els.pool.replaceChildren();
    round.tiles.forEach(function (tile) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tile";
      button.dataset.id = tile.id;
      button.textContent = labelOf(tile.text);
      button.addEventListener("click", function () { takeTile(tile.id); });
      els.pool.appendChild(button);
    });
    renderPicks();
  }

  function renderLast() {
    if (!lastSolved || phase === "success") {
      els.last.hidden = true;
      return;
    }
    els.last.hidden = false;
    const pos = lastSolved.pos ? " " + lastSolved.pos : "";
    els.last.textContent = "上一词 " + lastSolved.word + pos + " " + (lastSolved.meaning || "");
  }

  function render() {
    els.score.textContent = String(score);
    els.streak.textContent = String(streak);
    els.mistakeCount.textContent = String(mistakeWords.size);
    if (phase === "empty") {
      els.play.hidden = true;
      els.result.hidden = true;
      els.empty.hidden = false;
      els.clock.textContent = "—";
      els.timerBar.style.transform = "scaleX(0)";
      renderLast();
      return;
    }
    if (!round) return;
    if (phase === "play") renderPlay();
    if (phase === "success") showResult(round.entry, false);
    if (phase === "fail") showResult(round.entry, true);
    renderLast();
  }

  function paintBook(items, total, page, pages) {
    els.bookList.replaceChildren();
    els.bookPageLabel.textContent = total ? "第 " + page + " / " + pages + " 页，共 " + total + " 个" : "没有错词";
    els.bookPrev.disabled = page <= 1;
    els.bookNext.disabled = page >= pages || !total;
    if (!items.length) {
      const note = document.createElement("p");
      note.className = "empty-book";
      note.textContent = total ? "这一页没有错词。" : "还没有记错的单词。超时没组出来的词会出现在这里。";
      els.bookList.appendChild(note);
      return;
    }
    items.forEach(function (item) {
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = item.word;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = [item.pos, item.meaning || item.gloss, "错过 " + item.count + " 次"].filter(Boolean).join("  ");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "移出";
      remove.addEventListener("click", function () {
        forget(item.word);
      });
      li.append(title, sub, remove);
      els.bookList.appendChild(li);
    });
  }

  async function pageLocal() {
    let rows = Object.keys(mistakes).map(function (key) { return mistakes[key]; });
    const letter = els.bookLetter.value;
    if (letter !== "all") rows = rows.filter(function (item) { return item.word.charAt(0) === letter; });
    rows.sort(function (a, b) { return b.at - a.at; });
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    bookPage = Math.min(bookPage, pages);
    const start = (bookPage - 1) * PAGE_SIZE;
    return { items: rows.slice(start, start + PAGE_SIZE), total: rows.length, page: bookPage, pages: pages };
  }

  async function pageSqlite() {
    const query = new URLSearchParams({
      list: listId,
      letter: els.bookLetter.value,
      page: String(bookPage),
    });
    const response = await fetch("/api/mistakes?" + query.toString(), { cache: "no-store" });
    if (!response.ok) throw new Error("book failed");
    const data = await response.json();
    bookPage = data.page;
    return data;
  }

  async function renderBook() {
    const token = ++bookToken;
    els.bookWhere.textContent = useSqlite() ? "保存在 SQLite" : "保存在这台浏览器";
    try {
      const page = useSqlite() ? await pageSqlite() : await pageLocal();
      if (token !== bookToken) return;
      paintBook(page.items, page.total, page.page, page.pages);
    } catch (error) {
      if (token !== bookToken) return;
      paintBook([], 0, 1, 1);
      els.bookPageLabel.textContent = "错词本没有读出来";
    }
  }

  async function forget(word) {
    if (useSqlite()) {
      await fetch("/api/mistakes?list=" + encodeURIComponent(listId) + "&word=" + encodeURIComponent(word), { method: "DELETE" });
    } else {
      delete mistakes[word];
      saveLocal();
    }
    mistakeWords.delete(word);
    els.mistakeCount.textContent = String(mistakeWords.size);
    await renderBook();
    if (filter === "mistakes") {
      buildDeck();
      startRound();
    }
  }

  async function clearBook() {
    if (!window.confirm("清空当前词表的错词？")) return;
    if (useSqlite()) {
      await fetch("/api/mistakes?list=" + encodeURIComponent(listId), { method: "DELETE" });
    } else {
      mistakes = {};
      saveLocal();
    }
    mistakeWords = new Set();
    els.mistakeCount.textContent = "0";
    bookPage = 1;
    await renderBook();
    if (filter === "mistakes") {
      buildDeck();
      startRound();
    }
  }

  function applySettingsForm() {
    settings.matchWidth = els.optWidth.checked;
    const picked = document.querySelector("input[name='slot-hint']:checked");
    settings.slotHint = picked && picked.value === "line" ? "line" : "count";
    settings.useSqlite = els.optSqlite.checked;
    const seconds = Number(els.optSeconds.value);
    if (seconds >= 5 && seconds <= 180) settings.seconds = Math.round(seconds);
    saveSettings();
    updateSqliteNote();
  }

  function syncSettingsForm() {
    els.optWidth.checked = settings.matchWidth;
    els.optSqlite.checked = settings.useSqlite;
    els.optSeconds.value = String(settings.seconds);
    document.querySelectorAll("input[name='slot-hint']").forEach(function (input) {
      input.checked = input.value === settings.slotHint;
    });
    updateSqliteNote();
  }

  function onKey(event) {
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (event.key === "Backspace") {
      event.preventDefault();
      undo();
      return;
    }
    if (phase !== "play" || !round || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!/^[a-z'-]$/.test(key) && key !== " ") return;
    const tile = round.tiles.find(function (item) {
      return !item.used && item.text.toLowerCase() === key;
    });
    if (tile) takeTile(tile.id);
  }

  fillLists();
  fillRange();
  fillBookLetters();
  prepareList(lists[0].id);
  syncSettingsForm();

  els.undo.addEventListener("click", undo);
  els.clear.addEventListener("click", clearPicks);
  els.nextRound.addEventListener("click", startRound);
  els.range.addEventListener("change", function () {
    filter = els.range.value;
    buildDeck();
    startRound();
  });
  els.wordList.addEventListener("change", function () {
    prepareList(els.wordList.value);
    filter = "all";
    els.range.value = "all";
    bookPage = 1;
    syncMistakeIndex().then(function () {
      buildDeck();
      startRound();
    });
  });
  els.openBook.addEventListener("click", function () {
    bookPage = 1;
    renderBook();
    els.book.showModal();
  });
  els.failBook.addEventListener("click", function () {
    bookPage = 1;
    renderBook();
    els.book.showModal();
  });
  els.bookLetter.addEventListener("change", function () {
    bookPage = 1;
    renderBook();
  });
  els.bookPrev.addEventListener("click", function () {
    if (bookPage > 1) {
      bookPage -= 1;
      renderBook();
    }
  });
  els.bookNext.addEventListener("click", function () {
    bookPage += 1;
    renderBook();
  });
  els.practice.addEventListener("click", function () {
    filter = "mistakes";
    els.range.value = "mistakes";
    els.book.close();
    buildDeck();
    startRound();
  });
  els.clearMistakes.addEventListener("click", function () {
    clearBook();
  });
  els.openSettings.addEventListener("click", function () {
    syncSettingsForm();
    els.settingsDialog.showModal();
  });
  els.settingsDialog.addEventListener("change", function () {
    const wasSqlite = useSqlite();
    applySettingsForm();
    probeSqlite().then(function () {
      updateSqliteNote();
      return syncMistakeIndex();
    }).then(function () {
      if (wasSqlite !== useSqlite() && filter === "mistakes") {
        buildDeck();
        startRound();
      } else if (phase === "play") {
        renderPicks();
      }
    });
  });
  document.addEventListener("keydown", onKey);

  probeSqlite().then(syncMistakeIndex).then(function () {
    buildDeck();
    startRound();
  });
})();
