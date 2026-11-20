import {assertRuntimeRole} from './runtime-role';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { getConfig } from './config';

@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() { super({ adapter: new PrismaPg({ connectionString: getConfig().databaseUrl }) }); }
  async onModuleInit(): Promise<void> {
    await this.$connect();
    if(getConfig().appEnv === 'production')await assertRuntimeRole(this);
  }
  async onModuleDestroy(): Promise<void> { await this.$disconnect(); }
}
