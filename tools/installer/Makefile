.PHONY: build install clean

INSTALL_DIR ?= $(HOME)/.local/bin

build:
	cargo build --release

install: build
	@mkdir -p $(INSTALL_DIR)
	cp target/release/bakerst-install $(INSTALL_DIR)/bakerst-install
	@echo "Installed bakerst-install → $(INSTALL_DIR)/bakerst-install"

clean:
	cargo clean
