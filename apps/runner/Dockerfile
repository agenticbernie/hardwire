FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir platformio==6.2.0 \
    cryptography==46.0.7 ecdsa==0.19.2 bitstring==4.3.1 reedsolo==1.7.0 intelhex==2.3.0
RUN npm install --global opencode-ai@1.18.34 && npm cache clean --force
RUN curl --fail --location https://github.com/wokwi/wokwi-cli/releases/download/v0.28.1/wokwi-cli-linuxstatic-x64 --output /usr/local/bin/wokwi-cli \
    && echo '869f194ee473257c6112ed58d786376527769020056320b0a49a37d9e7d3bdd7  /usr/local/bin/wokwi-cli' | sha256sum --check \
    && chmod 0755 /usr/local/bin/wokwi-cli
ENV PATH="/opt/venv/bin:/usr/local/bin:/usr/bin:/bin"
# No source, credentials, tool auth cache, or product build artifacts enter this image.
WORKDIR /workspace
