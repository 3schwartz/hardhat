import Docker, { ContainerCreateOptions } from "dockerode";
import fsExtra from "fs-extra";
import { IncomingMessage } from "http";

import {
  BindDoesntExistInHostError,
  DockerBadGatewayError,
  DockerHubConnectionError,
  DockerNotInstalledError,
  DockerNotRunningError,
  DockerServerError,
  ExecutableNotFoundError,
  ImageDoesntExistError,
} from "./errors";
import { WritableBufferStream } from "./streams";
import { BindsMap, ContainerConfig, Image, ProcessResult } from "./types";

const DOCKER_SOCKET_PATH = "/var/run/docker.sock";

export class HardhatDocker {
  public static async create() {
    if (!(await HardhatDocker.isInstalled())) {
      throw new DockerNotInstalledError();
    }

    // TODO: This doesn't support windows
    if (!(await fsExtra.pathExists(DOCKER_SOCKET_PATH))) {
      throw new DockerNotRunningError();
    }

    const { default: DockerImpl } = await import("dockerode");

    return new HardhatDocker(DockerImpl);
  }

  public static async isInstalled(): Promise<boolean> {
    // TODO: This doesn't support windows
    const { exec } = await import("child_process");
    return new Promise((resolve) => {
      exec("which docker", (error?: any) => resolve(error === undefined));
    });
  }

  public static imageToRepoTag(image: Image) {
    return `${image.repository}:${image.tag}`;
  }

  private readonly _docker: Docker;

  // The constructor is private, see [[HardhatDocker.create]].
  private constructor(DockerImpl: typeof Docker) {
    // TODO: This doesn't support windows
    this._docker = new DockerImpl({ socketPath: DOCKER_SOCKET_PATH });
  }

  public async isRunning(): Promise<boolean> {
    try {
      const result = await this._withCommonErrors(this._docker.ping());
      return result === "OK";
    } catch (error) {
      if (error instanceof DockerNotRunningError) {
        return false;
      }

      if (error instanceof DockerBadGatewayError) {
        return false;
      }

      throw error;
    }
  }

  public async imageExists(image: Image): Promise<boolean> {
    const repositoryPath = this._imageToRepositoryPath(image);

    const imageEndpoint = `https://registry.hub.docker.com/v2/repositories/${repositoryPath}/tags/${image.tag}/`;

    try {
      const { request } = await import("undici");
      const res = await request(imageEndpoint, { method: "GET" });

      // "The Fetch Standard allows users to skip consuming the response body
      // by relying on garbage collection to release connection resources.
      // Undici does not do the same. Therefore, it is important to always
      // either consume or cancel the response body."
      // https://undici.nodejs.org/#/?id=garbage-collection
      // It's not clear how to "destroy", so we'll just consume:
      const _discarded = await res.body.text();

      return res.statusCode >= 200 && res.statusCode <= 299;
    } catch (error) {
      throw new DockerHubConnectionError(error as Error);
    }
  }

  public async hasPulledImage(image: Image): Promise<boolean> {
    const images = await this._withCommonErrors<Docker.ImageInfo[]>(
      this._docker.listImages()
    );

    return images.some(
      (img) =>
        img.RepoTags !== null &&
        img.RepoTags.some(
          (repoAndTag: string) =>
            repoAndTag === HardhatDocker.imageToRepoTag(image)
        )
    );
  }

  public async isImageUpToDate(image: Image): Promise<boolean> {
    const images = await this._withCommonErrors<Docker.ImageInfo[]>(
      this._docker.listImages()
    );

    const imageInfo = images.find(
      (img) =>
        img.RepoTags !== null &&
        img.RepoTags.some(
          (repoAndTag: string) =>
            repoAndTag === HardhatDocker.imageToRepoTag(image)
        )
    );

    if (imageInfo === undefined) {
      return false;
    }

    const remoteId = await this._getRemoteImageId(image);

    return imageInfo.Id === remoteId;
  }

  public async pullImage(image: Image): Promise<void> {
    if (!(await this.imageExists(image))) {
      throw new ImageDoesntExistError(image);
    }

    const im: IncomingMessage = await this._withCommonErrors(
      this._docker.pull(HardhatDocker.imageToRepoTag(image), {})
    );

    return new Promise((resolve, reject) => {
      im.on("end", resolve);
      im.on("error", reject);

      // Not having the data handler causes the process to exit
      im.on("data", () => {});
    });
  }

  public async runContainer(
    image: Image,
    command: string[],
    config: ContainerConfig = {}
  ): Promise<ProcessResult> {
    await this._validateBindsMap(config.binds);

    const createOptions: ContainerCreateOptions = {
      Tty: false,
      WorkingDir: config.workingDirectory,
      Entrypoint: "",
      HostConfig: {
        AutoRemove: true,
        Binds: this._bindsMapToArray(config.binds),
        NetworkMode: config.networkMode,
      },
    };

    const stdout = new WritableBufferStream();
    const stderr = new WritableBufferStream();

    const container = await this._withCommonErrors(
      this._docker.run(
        HardhatDocker.imageToRepoTag(image),
        command,
        [stdout, stderr],
        createOptions
      )
    );

    return {
      statusCode: container.output.StatusCode,
      stdout: stdout.buffer,
      stderr: stderr.buffer,
    };
  }

  private async _validateBindsMap(map?: BindsMap) {
    if (map === undefined) {
      return;
    }

    for (const hostPath of Object.keys(map)) {
      if (!(await fsExtra.pathExists(hostPath))) {
        throw new BindDoesntExistInHostError(hostPath);
      }
    }
  }

  private async _withCommonErrors<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (error: any) {
      if (error.code === "ECONNREFUSED") {
        throw new DockerNotRunningError(error);
      }

      if (error.statusCode === 502) {
        throw new DockerBadGatewayError(error);
      }

      if (error.statusCode === 500) {
        throw new DockerServerError(error);
      }

      if (
        error.statusCode === 400 &&
        (error.message?.includes("executable file not found") as boolean)
      ) {
        throw new ExecutableNotFoundError(error);
      }

      throw error;
    }
  }

  private _bindsMapToArray(map?: BindsMap) {
    if (map === undefined) {
      return [];
    }

    return Object.entries(map).map(
      ([host, container]) => `${host}:${container}`
    );
  }

  private async _getRemoteImageId(image: Image): Promise<string> {
    const token = await this._getDockerRegistryTokenForImage(image);

    const endpoint = `https://registry-1.docker.io/v2/${this._imageToRepositoryPath(
      image
    )}/manifests/${image.tag}`;

    try {
      const { request } = await import("undici");
      const res = await request(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/vnd.docker.distribution.manifest.v2+json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (!(res.statusCode >= 200 && res.statusCode <= 299)) {
        throw new Error(
          `Docker Registry manifest request not successful ${await res.body.text()}`
        );
      }

      const json = (await res.body.json()) as { config: { digest: string } };

      return json.config.digest;
    } catch (error) {
      throw new DockerHubConnectionError(error as Error);
    }
  }

  private async _getDockerRegistryTokenForImage(image: Image): Promise<string> {
    const endpoint = `https://auth.docker.io/token?scope=repository:${this._imageToRepositoryPath(
      image
    )}:pull&service=registry.docker.io`;

    try {
      const { request } = await import("undici");
      const res = await request(endpoint, { method: "GET" });

      if (!(res.statusCode >= 200 && res.statusCode <= 299)) {
        throw new Error(
          `Docker Registry auth request not successful ${await res.body.text()}`
        );
      }

      const json = (await res.body.json()) as { token: string };

      return json.token;
    } catch (error) {
      throw new DockerHubConnectionError(error as Error);
    }
  }

  private _imageToRepositoryPath(image: Image): string {
    return image.repository.includes("/")
      ? image.repository
      : `library/${image.repository}`;
  }
}
