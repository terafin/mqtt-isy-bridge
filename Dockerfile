FROM node:7-alpine

RUN mkdir -p /usr/app
COPY . /usr/app
WORKDIR /usr/app
RUN apt-get update; \
    apt-get -y install git

RUN npm install --production

# Cleaning
RUN apt-get -y remove build-essential; \
    apt -y autoremove; \
    apt-get clean

CMD ["npm", "start"]
