UUID := gink-video-wallpaper@ginkcode.github.io
EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
RUNTIME := metadata.json extension.js prefs.js

.PHONY: schemas install uninstall zip lint test nested logs

schemas:
	@if ls schemas/*.xml >/dev/null 2>&1; then glib-compile-schemas --strict schemas/; fi

# A running Shell maps the installed files; overwriting them in place corrupts
# its compiled schema and aborts it. Stage a copy and swap it in by rename.
install: schemas
	mkdir -p "$(dir $(EXTDIR))"
	rm -rf "$(EXTDIR).new" "$(EXTDIR).old"
	mkdir "$(EXTDIR).new"
	cp $(RUNTIME) LICENSE "$(EXTDIR).new/"
	cp -a lib prefs "$(EXTDIR).new/"
	@if ls schemas/*.xml >/dev/null 2>&1; then \
	  mkdir -p "$(EXTDIR).new/schemas" && \
	  cp schemas/*.xml schemas/gschemas.compiled "$(EXTDIR).new/schemas/"; \
	fi
	if [ -e "$(EXTDIR)" ]; then mv "$(EXTDIR)" "$(EXTDIR).old"; fi
	mv "$(EXTDIR).new" "$(EXTDIR)"
	rm -rf "$(EXTDIR).old"

uninstall:
	rm -rf "$(EXTDIR)"

zip: schemas
	mkdir -p dist
	gnome-extensions pack -f --extra-source=lib --extra-source=prefs -o dist

lint:
	npm run lint

test:
	@fail=0; \
	for f in tests/*.test.js; do \
	  [ -e "$$f" ] || exit 0; \
	  gjs -m "$$f" || fail=1; \
	done; \
	exit $$fail

nested:
	@if gnome-shell --help | grep -q -- --devkit; then \
	  dbus-run-session gnome-shell --devkit --wayland; \
	else \
	  dbus-run-session gnome-shell --nested --wayland; \
	fi

logs:
	journalctl --user -f -o cat | grep --line-buffered gink-vw
