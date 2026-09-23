# Образ решения. Раннер зовёт `make setup` в этом образе, поэтому внутри нужен
# make. Каталог /app совпадает с точкой монтирования решения в compose.
FROM node:26-alpine

RUN apk add --no-cache make

WORKDIR /app
