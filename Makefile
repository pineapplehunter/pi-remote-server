.PHONY: build css test

build: css
	mkdir -p .cache
	go build -o .cache/pi-remote-server .

css:
	tailwindcss -i styles/input.css -o public/style.css --minify

test: css
	go test ./...
	bun test
