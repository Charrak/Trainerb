import { Module } from '@nestjs/common';
import { IdentityController } from './controller';
import { Database } from './database';
import { RateLimiter } from './limiter';
import { Sessions } from './sessions';
import { Outbox } from './outbox';
import { Auth } from './auth';
import { Mfa } from './mfa';
import { Admin } from './admin';
import { Catalog } from './catalog';
import { CatalogController } from './catalog-controller';
import { Products } from './products';
import { ProductController } from './product-controller';
import { Publication } from './publication';
import { PublicationController } from './publication-controller';

@Module({ controllers:[IdentityController, CatalogController, ProductController, PublicationController], providers:[Database, RateLimiter, Sessions, Outbox, Auth, Mfa, Admin, Catalog, Products, Publication] })
export class AppModule {}
