// TidyTool — lead-gen site interactions
// Keep this file tiny and dependency-free.

(function () {
  "use strict";

  // --- Mobile nav toggle ---
  const navToggle = document.querySelector("[data-nav-toggle]");
  const nav = document.querySelector("[data-nav]");
  if (navToggle && nav) {
    navToggle.addEventListener("click", function () {
      const open = nav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    // Close the menu after clicking a link (mobile).
    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // --- Smooth scroll for in-page anchors ---
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      const id = this.getAttribute("href");
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // --- Reveal-on-scroll animation ---
  const revealEls = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && revealEls.length) {
    const io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealEls.forEach(function (el) {
      io.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  // --- Tally embed fallback ---
  // The quote-form iframes have no src until Tally's embed.js sets it from
  // data-tally-src. If that script is blocked (ad-blocker, strict corporate
  // network), the card would sit blank — show a direct link instead. If the
  // embed recovers late, remove the fallback again.
  const tallyFrames = document.querySelectorAll("iframe[data-tally-src]");
  if (tallyFrames.length) {
    const tallyFormUrl = function (frame) {
      const m = (frame.getAttribute("data-tally-src") || "").match(/tally\.so\/embed\/([A-Za-z0-9]+)/);
      return "https://tally.so/r/" + (m ? m[1] : "LZoGyG");
    };
    const checkTally = function () {
      tallyFrames.forEach(function (frame) {
        let note = frame.parentNode.querySelector(".form-fallback");
        if (!frame.src) {
          if (!note) {
            note = document.createElement("p");
            note.className = "form-fallback";
            note.innerHTML =
              'Trouble loading the form? <a href="' + tallyFormUrl(frame) +
              '" target="_blank" rel="noopener">Open it in a new tab →</a> ' +
              'or email <a href="mailto:sam@thetidytool.com">sam@thetidytool.com</a>.';
            frame.parentNode.insertBefore(note, frame);
          }
        } else if (note) {
          note.remove();
        }
      });
    };
    setTimeout(checkTally, 4000);
    setTimeout(checkTally, 10000);
  }

  // --- Footer year ---
  const yearEl = document.querySelector("[data-year]");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
