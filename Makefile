NPM_PACKAGE := $(shell node -e 'process.stdout.write(require("./package.json").name)')
NPM_VERSION := $(shell node -e 'process.stdout.write(require("./package.json").version)')

TMP_PATH    := /tmp/${NPM_PACKAGE}-$(shell date +%s)

REMOTE_NAME ?= origin
REMOTE_REPO ?= $(shell git config --get remote.${REMOTE_NAME}.url)

CURR_HEAD   := $(firstword $(shell git show-ref --hash HEAD | cut -b -6) master)
GITHUB_PROJ := nodeca/${NPM_PACKAGE}


help:
	echo "make help       - Print this help"
	echo "make lint       - Lint sources with JSHint"
	echo "make test       - Run tests"
	echo "make browserify - Build browserified packages"

lint:
	./node_modules/.bin/eslint .

test: lint
	./node_modules/.bin/mocha

browserify:
	rm -rf ./dist
	mkdir dist
	# Browserify
	( printf %s "/* ${NPM_PACKAGE} ${NPM_VERSION} ${GITHUB_PROJ} */" ; \
		./node_modules/.bin/browserify -r ./lib/deflate.js  --bare --no-browser-field \
		) > dist/pako_deflate.js

	# Minify
	./node_modules/.bin/uglifyjs dist/pako_deflate.js -c -m \
		--mangle-props regex='/^_/' \
		--preamble "/* ${NPM_PACKAGE} ${NPM_VERSION} ${GITHUB_PROJ} */" \
		> dist/pako_deflate.min.js

	# Minify
	./node_modules/.bin/uglifyjs dist/pako_deflate.js -c -m \
		--mangle-props regex='/^_/' \
		--preamble "/* ${NPM_PACKAGE} ${NPM_VERSION} ${GITHUB_PROJ} */" \
		--beautify \
		> dist/pako_deflate.pretty.js

	# Update bower package
	#sed -i -r -e \
	#	"s/(\"version\":\s*)\"[0-9]+[.][0-9]+[.][0-9]+\"/\1\"${NPM_VERSION}\"/" \
	#	bower.json



.PHONY: publish lint doc
.SILENT: help lint
