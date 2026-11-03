.PHONY: install dev smoke compose build

install:
	npm install --prefix one
	npm install --prefix two
	npm install --prefix three
	npm install --prefix four
	npm install --prefix five

dev:
	./scripts/dev.sh

smoke:
	node scripts/smoke.js

compose:
	docker compose up --build

build:
	./scripts/build-multiarch.sh
