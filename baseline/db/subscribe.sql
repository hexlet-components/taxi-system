CREATE SUBSCRIPTION taxi
CONNECTION 'host=db user=postgres dbname=taxi'
PUBLICATION taxi;
