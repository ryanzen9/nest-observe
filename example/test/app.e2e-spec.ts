import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Nest Observe example', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.OBSERVE_ENABLED = 'false';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.OBSERVE_ENABLED;
  });

  it('exposes a health endpoint', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'nest-observe-example' });
  });

  it('runs a traced business operation', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ sku: 'SKU-001', quantity: 2 })
      .expect(201);

    expect(response.body).toMatchObject({
      sku: 'SKU-001',
      quantity: 2,
      status: 'created',
    });
    expect(response.body.id).toEqual(expect.any(String));
  });

  it('exposes a route that demonstrates exception capture', async () => {
    await request(app.getHttpServer())
      .get('/orders/demo/failure')
      .expect(500)
      .expect({ statusCode: 500, message: 'Internal server error' });
  });
});
