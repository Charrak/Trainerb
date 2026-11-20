import {PrivacyRequests} from './privacy-requests';
import {NewsletterController} from './newsletter-controller';
import { NavigationController } from './navigation-controller';
import { ProviderProfileController } from './provider-profile';
import { EditorialController } from './editorial-controller';
import { DashboardController } from './dashboard-controller';
import { BackofficeOperations } from './backoffice-operations';
import { CertificateController } from './certificate-controller';
import { ExamRunner } from './exam-runner';
import { ExamController } from './exam-controller';
import { Module } from '@nestjs/common';
import { IdentityController } from './controller';
import { Database } from './database';
import { RateLimiter } from './limiter';
import { Sessions } from './sessions';
import { Outbox } from './outbox';
import { Auth } from './auth';
import { Mfa } from './mfa';
import { Customers } from './customers';
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
import { Invoices } from './invoices';
import { Refunds } from './refunds';
import { Disputes } from './disputes';
import { Withdrawals } from './withdrawals';

@Module({ controllers:[PrivacyRequests, NewsletterController, NavigationController, ProviderProfileController, EditorialController, DashboardController, BackofficeOperations, CertificateController, ExamController, IdentityController, CatalogController, ProductController, PublicationController,
  ShopController, CommerceAdminController, GuestController], providers:[ExamRunner, Database, RateLimiter, Sessions, Outbox, Auth,
  Mfa, Admin, Customers, Catalog, Products, Publication, Shop, Learning, Accesses, Commerce, StripePayments, GuestCheckout,
  Invoices, Refunds, Disputes, Withdrawals] })
export class AppModule {}
