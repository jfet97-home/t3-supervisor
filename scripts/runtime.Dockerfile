FROM public.ecr.aws/docker/library/node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY vendor/ /opt/runtime/
COPY scripts/cx /usr/local/bin/cx
USER 501:20
