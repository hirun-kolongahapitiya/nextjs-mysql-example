import { Model } from "objection";
import knexConfig from "../../knexfile";
import knex, { Knex } from "knex";

const env = (process.env.NODE_ENV === 'production' ? 'production' : 'development') as
  keyof typeof knexConfig;
const knexInstance: Knex = knex(knexConfig[env]);
Model.knex(knexInstance);

class User extends Model {
  static get tableName() {
    return 'users';
  }
}

export default User;
