FROM node:6-alpine

RUN mkdir -p /usr/app
COPY . /usr/app
WORKDIR /usr/app
RUN apk add --no-cache git

RUN npm install --production

# Cleaning

CMD ["npm", "start"]
