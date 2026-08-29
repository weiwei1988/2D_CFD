EMXX ?= em++
TARGET := cfd-core.js
SOURCE := cfd-core.cpp

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(SOURCE)
	$(EMXX) $(SOURCE) -std=c++17 -O3 -flto \
		-s MODULARIZE=1 -s EXPORT_NAME=createCFDCore \
		-s ENVIRONMENT=web,node -s FILESYSTEM=0 -s MALLOC=emmalloc \
		-s INITIAL_MEMORY=16777216 -s ALLOW_MEMORY_GROWTH=0 \
		-s ASSERTIONS=0 -s EXPORTED_RUNTIME_METHODS='["HEAPF32"]' \
		-o $(TARGET)

clean:
	rm -f cfd-core.js cfd-core.wasm
