import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { SERVICE_DESCRIPTION, SERVICE_NAME, SERVICE_VERSION } from "./pkg";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle(`${SERVICE_NAME} API`)
    .setDescription(SERVICE_DESCRIPTION)
    .setVersion(SERVICE_VERSION)
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, swaggerDocument);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(
    `Example application is listening on http://localhost:${port}`,
    "Bootstrap",
  );
}

void bootstrap();
