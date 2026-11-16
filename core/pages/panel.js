/* Squire's comment panel, served by the page server at /squire/panel.js and
   loaded by a page Squire makes with
     <link rel="stylesheet" href="/squire/style.css">
     <script src="/squire/panel.js" defer></script>
   It adds a panel at the end of the page: the words commented on (filled from
   the words selected on the page, or typed), the comment, a list of the
   comments added, and a button that saves them for Squire. Every control is an
   ordinary form element in the order it is used, and the first stop of the Tab
   key is a link straight to the panel. Saving posts JSON to /api/review on the
   server the page came from; nothing goes anywhere else. */
(function () {
  "use strict";

  var comments = [];
  var count = 0;
  var lastSelection = "";

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text) node.textContent = text;
    return node;
  }

  var skip = el("a", { href: "#squire-panel", "class": "squire-skip" }, "Comment on this page");
  var panel = el("aside", { id: "squire-panel", "class": "squire-panel", "aria-labelledby": "squire-panel-title", tabindex: "-1" });
  var title = el("h2", { id: "squire-panel-title" }, "Comments for Squire");
  var quoteLabel = el("label", { "for": "squire-quote" }, "The words you are commenting on");
  var quote = el("textarea", { id: "squire-quote", rows: "2" });
  var useSelection = el("button", { type: "button", "class": "squire-quiet" }, "Use the words selected on the page");
  var noteLabel = el("label", { "for": "squire-note" }, "Your comment");
  var note = el("textarea", { id: "squire-note", rows: "3" });
  var add = el("button", { type: "button" }, "Add comment");
  var list = el("ol", { "aria-label": "Comments added" });
  var save = el("button", { type: "button" }, "Save comments for Squire");
  var status = el("p", { "class": "squire-status", role: "status", "aria-live": "polite" });

  [title, quoteLabel, quote, useSelection, noteLabel, note, add, list, save, status].forEach(function (n) {
    panel.appendChild(n);
  });
  document.body.insertBefore(skip, document.body.firstChild);
  document.body.appendChild(panel);

  function say(words) { status.textContent = words; }

  document.addEventListener("selectionchange", function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return;
    var node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    if (node && node.closest && node.closest("#squire-panel")) return;
    var text = sel.toString().trim();
    if (text) lastSelection = text.slice(0, 4000);
  });

  useSelection.addEventListener("click", function () {
    if (!lastSelection) { say("Select some words on the page first, then use this button."); return; }
    quote.value = lastSelection;
    note.focus();
  });

  function render() {
    list.textContent = "";
    comments.forEach(function (c) {
      var item = el("li");
      if (c.quote) item.appendChild(el("blockquote", {}, c.quote));
      item.appendChild(el("p", {}, c.comment));
      var remove = el("button", { type: "button", "class": "squire-quiet" }, "Remove this comment");
      remove.addEventListener("click", function () {
        comments = comments.filter(function (x) { return x.id !== c.id; });
        render();
        say("Comment removed.");
        add.focus();
      });
      item.appendChild(remove);
      list.appendChild(item);
    });
  }

  add.addEventListener("click", function () {
    var words = note.value.trim();
    if (!words) { say("Write your comment first."); note.focus(); return; }
    count += 1;
    comments.push({ id: "c" + count, quote: quote.value.trim().slice(0, 4000), comment: words.slice(0, 8000) });
    quote.value = "";
    note.value = "";
    render();
    say(comments.length === 1 ? "1 comment added. Add another, or save." : comments.length + " comments added. Add another, or save.");
    quote.focus();
  });

  save.addEventListener("click", function () {
    if (!comments.length) { say("There is nothing to save yet."); return; }
    fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: location.pathname, comments: comments })
    }).then(function (r) {
      if (!r.ok) throw new Error("refused");
      comments = [];
      render();
      say("Saved. Tell Squire you have left comments on this page.");
    }).catch(function () {
      say("The comments could not be saved. Try again, or tell Squire in the chat.");
    });
  });
})();
