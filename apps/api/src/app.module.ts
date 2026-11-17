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
import { Shop } from './shop';
import { ShopController, CommerceAdminController } from './shop-controller';
import { Learning, Accesses } from './learning';
import { Commerce } from './commerce';
import { StripePayments } from './stripe';
import { GuestCheckout } from './guest';
import { GuestController } from './guest-controller';

@Module({ controllers:[IdentityController, CatalogController, ProductController, PublicationController,
  ShopController, CommerceAdminController, GuestController], providers:[Database, RateLimiter, Sessions, Outbox, Auth,
  Mfa, Admin, Catalog, Products, Publication, Shop, Learning, Accesses, Commerce, StripePayments, GuestCheckout] })
export class AppModule {}
